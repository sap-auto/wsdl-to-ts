import * as soap from "soap";
import { open_wsdl } from "soap/lib/wsdl";

// import { diffLines } from "diff";

const NEW_LINE = `
`;
const EMPTY_LINE = `${NEW_LINE}${NEW_LINE}`;
const GENERATED_DATA_STRING = "GeneratedDataString";

export const nsEnums: { [k: string]: boolean } = {};

interface ITwoDown<T> {
  [k: string]: { [k: string]: T };
}

interface IInterfaceObject {
  [key: string]: string | IInterfaceObject;
}

export interface IInterfaceOptions {
  quoteProperties?: boolean;
}

export interface ITypedWsdl {
  client: soap.Client | null;
  files: ITwoDown<string>;
  methods: ITwoDown<{ [k: string]: string }>;
  types: ITwoDown<{ [k: string]: string }>;
  namespaces: ITwoDown<{ [k: string]: { [k: string]: string } }>;
}

export class TypeCollector {
  public readonly registered: { [k: string]: string };
  public readonly collected: { [k: string]: string };

  constructor(public readonly ns: string) {
    this.registered = {};
    this.collected = {};
  }

  public registerCollected() {
    for (const k of Object.keys(this.collected)) {
      if (this.collected[k]) {
        this.registered[k] = this.collected[k];
      } else {
        delete this.registered[k];
      }
      delete this.collected[k];
    }
    return this;
  }
}

const xsTypes = new Map<string, string>([
  ["integer", "number"],
  ["decimal", "number"],
  ["int", "number"],
  ["long", "number"],
  ["double", "number"],
  ["dateTime", "Date"],
  ["date", "Date"],
  ["time", "Date"],
  ["anyType", "any"],
  ["base64Binary", "string"],
]);

const tsTypes: { [key: string]: boolean } = {
  boolean: true,
  number: true,
  string: true,
};
xsTypes.forEach((val: string) => {
  tsTypes[val] = true;
});

const toTsName = (name: string) => name.replace(/[^a-z0-9]/i, "_");

const parseType: (type: string) => string = (type) => {
  const [ns, name] = type.split(":");
  if (ns === "tns") {
    return name;
  } else if (name === "dateTime") {
    return "Date";
  } else if (name === "int" || name === "double" || name === "decimal") {
    return "number";
  }
  return name;
};

const isOptional: (node: any) => boolean = (node) => node.$nillable === "true" || node.$minOccurs === "0";
const isList: (node: any) => boolean = (node) => node.$minOccurs === "0" && node.$maxOccurs;

const schemaNodeToTypeString: (node: any, context?: { baseType?: string }) => string = (node, context = {}) => {
  const { baseType } = context;

  if (Array.isArray(node) && typeof node.length === "number") {
    return node.map((el) => schemaNodeToTypeString(el, context)).join(NEW_LINE);
  } else if (node.name === "simpleType") {
    const simpleTypeDef = schemaNodeToTypeString(node.children);
    return simpleTypeDef
      ? `export enum ${toTsName(node.$name)} {${NEW_LINE}${schemaNodeToTypeString(node.children, context)}${NEW_LINE}}`
      : "";
  } else if (node.name === "complexType") {
    return `export type ${toTsName(node.$name)} = ${schemaNodeToTypeString(node.children, context)}`;
  } else if (node.name === "sequence") {
    return `{${NEW_LINE}${schemaNodeToTypeString(node.children, context)}${NEW_LINE}}`;
  } else if (
    node.name === "element" &&
    (/^tns/.test(node.$type) ||
      node.$type === "xs:int" ||
      node.$type === "xs:double" ||
      node.$type === "xs:decimal" ||
      node.$type === "xs:boolean" ||
      node.$type === "xs:dateTime" ||
      node.$type === "xs:string")
  ) {
    return `  ${toTsName(node.$name)}${isOptional(node) ? "?" : ""}: ${toTsName(parseType(node.$type))}${
      isList(node) ? "[]" : ""
    };`;
  } else if (node.name === "restriction") {
    return schemaNodeToTypeString(node.children, {
      ...context,
      baseType: parseType(node.$base),
    });
  } else if (node.name === "enumeration" && baseType === "string") {
    return `  ${node.$value} = "${node.$value}",`;
  } else if (node.name === "complexContent") {
    return schemaNodeToTypeString(node.children, context);
  } else if (node.name === "extension") {
    return `${parseType(node.$base)} & ${schemaNodeToTypeString(node.children, context)}`;
  } else if (node.name === "pattern") {
    return "";
  } else {
    console.log("unhandled", node.name, node);
  }
};

const wsdlSchemaGroupsToTypeString = (schema: any, keys: string[]) =>
  keys
    .map((key) => {
      const objects = schema[key];
      return Object.keys(objects)
        .map((objKey) => schemaNodeToTypeString(objects[objKey]))
        .join(EMPTY_LINE);
    })
    .join(EMPTY_LINE);

const wsdlSchemaToTypeString = (schemas: any) =>
  Object.keys(schemas)
    .map((key) => wsdlSchemaGroupsToTypeString(schemas[key], ["types", "complexTypes"]))
    .join(EMPTY_LINE);

function wsdlTypeToInterfaceObj(obj: IInterfaceObject, typeCollector?: TypeCollector): { [k: string]: any } {
  const r: { [k: string]: any } = {};
  for (const k of Object.keys(obj)) {
    if (k === "targetNSAlias" || k === "targetNamespace") {
      continue;
    }
    const isArray = k.endsWith("[]");
    const k2 = isArray ? k.substring(0, k.length - 2) : k;
    const v = obj[k];
    const t = typeof v;
    if (t === "string") {
      const vstr = v as string;
      const [typeName, superTypeClass, typeData] = vstr.indexOf("|") === -1 ? [vstr, vstr, undefined] : vstr.split("|");
      const typeFullName = obj.targetNamespace ? obj.targetNamespace + "#" + typeName : typeName;
      let typeClass = superTypeClass;

      const xsTypeParts = superTypeClass.split(":");
      const xsTypeWithoutNsPrefix = xsTypeParts[1] || xsTypeParts[0];
      const resolvedXsType = xsTypes.get(xsTypeWithoutNsPrefix) || xsTypeWithoutNsPrefix;

      if (resolvedXsType) {
        typeClass = resolvedXsType;
      } else if (nsEnums[typeFullName] || typeData) {
        const filter = nsEnums[typeFullName]
          ? () => true
          : (x: string) => x !== "length" && x !== "pattern" && x !== "maxLength" && x !== "minLength";
        const tdsplit = typeData.split(",").filter(filter);
        if (tdsplit.length) {
          typeClass = '"' + tdsplit.join('" | "') + '"';
        }
      }
      if (isArray) {
        if (/^[A-Za-z0-9.]+$/.test(typeClass)) {
          typeClass += "[]";
        } else {
          typeClass = "Array<" + typeClass + ">";
        }
      }
      r[k2] = "/** " + typeFullName + "(" + typeData + ") */ " + typeClass + ";";
    } else {
      const to = wsdlTypeToInterfaceObj(v as IInterfaceObject, typeCollector);
      let tr: { [k: string]: any } | string;
      if (isArray) {
        let s = wsdlTypeToInterfaceString(to);
        if (typeCollector && typeCollector.ns) {
          if (typeCollector.registered.hasOwnProperty(k2) && typeCollector.registered[k2] === s) {
            s = typeCollector.ns + ".I" + k2 + ";";
          } else if (typeCollector.collected.hasOwnProperty(k2)) {
            if (typeCollector.collected[k2] !== s) {
              typeCollector.collected[k2] = null;
            }
          } else {
            typeCollector.collected[k2] = s;
          }
        }
        s = s.replace(/\n/g, "\n    ");

        if (s.startsWith("/**")) {
          const i = s.indexOf("*/") + 2;
          s = s.substring(0, i) + " Array<" + s.substring(i).trim().replace(/;$/, "") + ">;";
        } else {
          s = s.trim().replace(/;$/, "");
          if (/^[A-Za-z0-9.]+$/.test(s)) {
            s += "[];";
          } else {
            s = "Array<" + s + ">;";
          }
        }

        tr = s;
      } else {
        tr = to;
        if (typeCollector && typeCollector.ns) {
          const ss = wsdlTypeToInterfaceString(to);
          if (typeCollector.registered.hasOwnProperty(k2) && typeCollector.registered[k2] === ss) {
            tr = typeCollector.ns + ".I" + k2 + ";";
          } else if (typeCollector.collected.hasOwnProperty(k2)) {
            if (typeCollector.collected[k2] !== ss) {
              typeCollector.collected[k2] = null;
            }
          } else {
            typeCollector.collected[k2] = ss;
          }
        }
      }
      r[k2] = tr;
    }
  }
  // console.log("wsdlTypeToInterfaceObj:", r);
  return r;
}

function wsdlTypeToInterfaceString(d: { [k: string]: any }, opts: IInterfaceOptions = {}): string {
  const r: string[] = [];
  for (const k of Object.keys(d)) {
    const t = typeof d[k];
    let p: string = k;
    if (opts.quoteProperties || (opts.quoteProperties === undefined && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(k))) {
      p = JSON.stringify(k);
    }
    if (t === "string") {
      const v = d[k];
      if (v.startsWith("/**")) {
        const i = v.indexOf("*/") + 2;
        r.push(v.substring(0, i));

        // for types like "xsd:string" only the "string" part is used
        const rawtype = v.substring(i).trim();
        const colon = rawtype.indexOf(":");
        if (colon !== -1) {
          const preamble = rawtype.substring(0, colon);
          const lastOpenBracket = preamble.lastIndexOf("<");
          if (lastOpenBracket !== -1) {
            r.push(p + ": " + preamble.substring(0, lastOpenBracket + 1) + rawtype.substring(colon + 1));
          } else {
            r.push(p + ": " + rawtype.substring(colon + 1));
          }
        } else {
          r.push(p + ": " + rawtype);
        }
      } else {
        r.push(p + ": " + v);
      }
    } else {
      r.push(p + ": " + wsdlTypeToInterfaceString(d[k], opts).replace(/\n/g, "\n    ") + ";");
    }
  }
  if (r.length === 0) {
    return "{}";
  }
  return "{\n    " + r.join("\n    ") + "\n}";
}

function wsdlTypeToInterface(
  obj: { [k: string]: any },
  typeCollector?: TypeCollector,
  opts?: IInterfaceOptions,
): string {
  return wsdlTypeToInterfaceString(wsdlTypeToInterfaceObj(obj, typeCollector), opts);
}

export function wsdl2ts(wsdlUri: string, opts?: IInterfaceOptions): Promise<ITypedWsdl> {
  return new Promise<soap.Client>((resolve, reject) => {
    soap.createClient(wsdlUri, {}, (err: any, client: soap.Client) => {
      if (err) {
        reject(err);
      } else {
        resolve(client);
      }
    });
  })
    .then((client) => {
      const r: ITypedWsdl = {
        client,
        files: {},
        methods: {},
        namespaces: {},
        types: {},
      };
      const d = client.describe();
      //console.log(d); /////////////////////////////////////////////
      for (const service of Object.keys(d)) {
        for (const port of Object.keys(d[service])) {
          const collector = new TypeCollector(port + "Types");
          // console.log("-- %s.%s", service, port);

          if (!r.types[service]) {
            r.types[service] = {};
            r.methods[service] = {};
            r.files[service] = {};
            r.namespaces[service] = {};
          }
          if (!r.types[service][port]) {
            r.types[service][port] = {};
            r.methods[service][port] = {};
            r.files[service][port] = service + "/" + port;
            r.namespaces[service][port] = {};
          }

          for (let maxi = 0; maxi < 32; maxi++) {
            for (const method of Object.keys(d[service][port])) {
              // console.log("---- %s", method);

              wsdlTypeToInterface(d[service][port][method].input || {}, collector, opts);
              wsdlTypeToInterface(d[service][port][method].output || {}, collector, opts);
            }

            const reg = cloneObj(collector.registered);
            collector.registerCollected();
            const regKeys0: string[] = Object.keys(collector.registered);
            const regKeys1: string[] = Object.keys(reg);
            if (regKeys0.length === regKeys1.length) {
              let noChange = true;
              for (const rk of regKeys0) {
                if (collector.registered[rk] !== reg[rk]) {
                  noChange = false;
                  break;
                }
              }
              if (noChange) {
                break;
              }
            }
            if (maxi === 31) {
              console.warn("wsdl-to-ts: Aborted nested interface changes");
            }
          }

          const collectedKeys: string[] = Object.keys(collector.registered);
          if (collectedKeys.length) {
            const ns: { [k: string]: string } = (r.namespaces[service][port][collector.ns] = {});
            for (const k of collectedKeys) {
              ns[k] = "export interface I" + k + " " + collector.registered[k];
            }
          }

          for (const method of Object.keys(d[service][port])) {
            r.types[service][port]["I" + method + "Input"] = wsdlTypeToInterface(
              d[service][port][method].input || {},
              collector,
              opts,
            );
            r.types[service][port]["I" + method + "Output"] = wsdlTypeToInterface(
              d[service][port][method].output || {},
              collector,
              opts,
            );
            r.methods[service][port][method] =
              "(input: Partial<I" +
              method +
              "Input>, " +
              "cb: (err: any | null," +
              " result: I" +
              method +
              "Output," +
              " rawResult: string, " +
              " soapHeader: {[k: string]: any; }, " +
              " rawRequest: string) => any, " +
              "options?: any, " +
              "extraHeaders?: any" +
              ") => void";
            r.methods[service][port][method + "Async"] =
              "(input: Partial<I" +
              method +
              "Input>, " +
              "options?: any, " +
              "extraHeaders?: any" +
              ") => Promise<[I" +
              method +
              "Output, string, {[k: string]: any; }, string]>";
          }
        }
      }

      return r;
    })
    .then((out) => {
      return new Promise<ITypedWsdl>((resolve, reject) => {
        out.files.Common = { Types: "Types" };
        open_wsdl(wsdlUri, (error, wsdl) => {
          if (error) {
            reject(error);
          }
          out.types.Common = {
            Types: {
              [GENERATED_DATA_STRING]: wsdlSchemaToTypeString(wsdl.definitions.schemas),
            },
          };
          resolve(out);
        });
      });
    });
}

function cloneObj<T extends { [k: string]: any }>(a: T): T {
  const b: T = {} as any;
  for (const k of Object.keys(a)) {
    const t = typeof a[k];
    (b as any)[k] = t === "object" ? (Array.isArray(a[k]) ? a[k].slice() : cloneObj(a[k])) : a[k];
  }
  return b;
}

export function mergeTypedWsdl(a: ITypedWsdl, ...bs: ITypedWsdl[]): ITypedWsdl {
  const x: ITypedWsdl = {
    client: null,
    files: cloneObj(a.files),
    methods: cloneObj(a.methods),
    namespaces: cloneObj(a.namespaces),
    types: cloneObj(a.types),
  };
  for (const b of bs) {
    for (const service of Object.keys(b.files)) {
      if (!x.files.hasOwnProperty(service)) {
        x.files[service] = cloneObj(b.files[service]);
        x.methods[service] = cloneObj(b.methods[service]);
        x.types[service] = cloneObj(b.types[service]);
        x.namespaces[service] = cloneObj(b.namespaces[service]);
      } else {
        for (const port of Object.keys(b.files[service])) {
          if (!x.files[service].hasOwnProperty(port)) {
            x.files[service][port] = b.files[service][port];
            x.methods[service][port] = cloneObj(b.methods[service][port]);
            x.types[service][port] = cloneObj(b.types[service][port]);
            x.namespaces[service][port] = cloneObj(b.namespaces[service][port]);
          } else {
            x.files[service][port] = b.files[service][port];
            for (const method of Object.keys(b.methods[service][port])) {
              x.methods[service][port][method] = b.methods[service][port][method];
            }
            for (const type of Object.keys(b.types[service][port])) {
              x.types[service][port][type] = b.types[service][port][type];
            }
            for (const ns of Object.keys(b.namespaces[service][port])) {
              if (!x.namespaces[service][port].hasOwnProperty(ns)) {
                x.namespaces[service][port][ns] = cloneObj(b.namespaces[service][port][ns]);
              } else {
                for (const nsi of Object.keys(b.namespaces[service][port][ns])) {
                  x.namespaces[service][port][ns][nsi] = b.namespaces[service][port][ns][nsi];
                }
              }
            }
          }
        }
      }
    }
  }
  return x;
}

const getTypes = (str: string) =>
  (str.match(/: \b[^;]*\b/g) || []).map((match) => match.substr(2)).filter((type) => !tsTypes[type]);

const uniq = (arr: string[]) =>
  Object.keys(
    arr.reduce(
      (out, curr) => ({
        ...out,
        [curr]: true,
      }),
      {},
    ),
  );

export function outputTypedWsdl(a: ITypedWsdl): Array<{ file: string; data: string[] }> {
  const r: Array<{ file: string; data: string[] }> = [];
  for (const service of Object.keys(a.files)) {
    for (const port of Object.keys(a.files[service])) {
      const d: { file: string; data: string[] } = {
        file: a.files[service][port],
        data: [],
      };
      const unknownTypes: string[] = [];
      if (a.types[service] && a.types[service][port]) {
        for (const type of Object.keys(a.types[service][port])) {
          if (type === GENERATED_DATA_STRING) {
            d.data.push(a.types[service][port][type]);
          } else {
            getTypes(a.types[service][port][type]).forEach((t) => unknownTypes.push(t));
            d.data.push("export interface " + type + " " + a.types[service][port][type]);
          }
        }
      }
      if (unknownTypes.length) {
        d.data.unshift(`import { ${uniq(unknownTypes).join(", ")} } from '../Types';`);
      }
      if (a.methods[service] && a.methods[service][port]) {
        d.data.unshift(`import { Client } from 'soap';`);
        const ms: string[] = [];
        for (const method of Object.keys(a.methods[service][port])) {
          ms.push(method + ": " + a.methods[service][port][method] + ";");
        }
        if (ms.length) {
          d.data.push("export interface I" + port + "Soap extends Client {\n    " + ms.join("\n    ") + "\n}");
        }
      }
      if (a.namespaces[service] && a.namespaces[service][port]) {
        for (const ns of Object.keys(a.namespaces[service][port])) {
          const ms: string[] = [];
          for (const nsi of Object.keys(a.namespaces[service][port][ns])) {
            ms.push(a.namespaces[service][port][ns][nsi].replace(/\n/g, "\n    "));
          }
          if (ms.length) {
            d.data.push("export namespace " + ns + " {\n    " + ms.join("\n    ") + "\n}");
          }
        }
      }
      r.push(d);
    }
  }
  return r;
}
