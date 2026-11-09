import path from "node:path";

/**
 * Where Blueprint keeps clones, working copies, rebuilt schemas and baseline
 * results. It sits under the framework's data/ folder in a `.cache` folder so
 * source scans (agent-native doctor among them) skip the imported repos'
 * code, which is not this app's code.
 */
export const DATA_DIR = path.resolve(process.cwd(), "data/.cache/blueprint");

export const dataPath = (...parts: string[]) => path.join(DATA_DIR, ...parts);
