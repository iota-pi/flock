export type JSONPrimitive = string | number | boolean | null;
export type JSONValue = JSONPrimitive | JSONValue[];
export type JSONObject = { [key: string]: JSONValue };
export type JSONData = JSONObject | JSONValue;
