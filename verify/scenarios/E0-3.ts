import { execFileSync } from "node:child_process";
import E01 from "./E0-1.ts";

/** E0-3: every test passes without a model key, and the E0-1 demo runs on the mock model server. */
export default async function scenario(baseUrl: string): Promise<void> {
  const withoutModel = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("MODEL_")),
  );

  execFileSync("vp", ["test", "run"], { stdio: "inherit", env: withoutModel });
  await E01(baseUrl);
}
