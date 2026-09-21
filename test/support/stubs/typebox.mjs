// Stub of the typebox builders used for the duker_loop parameter schema (plain JSON Schema out).
const withOpts = (schema, opts = {}) => ({ ...schema, ...opts });
export const Type = {
	Object: (properties, opts) => withOpts({ type: "object", properties, required: Object.keys(properties).filter((k) => !properties[k][OPTIONAL]) }, opts),
	Optional: (schema) => ({ ...schema, [OPTIONAL]: true }),
	Integer: (opts) => withOpts({ type: "integer" }, opts),
	Number: (opts) => withOpts({ type: "number" }, opts),
	String: (opts) => withOpts({ type: "string" }, opts),
	Boolean: (opts) => withOpts({ type: "boolean" }, opts),
	Array: (items, opts) => withOpts({ type: "array", items }, opts),
};
const OPTIONAL = Symbol("optional");
