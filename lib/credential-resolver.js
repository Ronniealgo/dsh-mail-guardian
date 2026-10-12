import fs from "node:fs/promises";
// The background adapter shares DSH's official document parser, never a regex
// pretending to parse YAML. Only named mail references are returned per operation.
export function createFileResolver({ filename, parseCredentialsDocument }) {
  if (typeof parseCredentialsDocument !== "function")
    throw new TypeError("official credentials parser required");
  return async (ref) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref))
      throw new TypeError("invalid credential reference");
    try {
      const parsed = parseCredentialsDocument(
        await fs.readFile(filename, "utf8"),
        filename,
      );
      return parsed.refs.get(ref) ?? null;
    } catch {
      const e = new Error("邮箱凭据读取失败，请在 DSH 密钥库中检查配置");
      e.kind = "credentials";
      throw e;
    }
  };
}
