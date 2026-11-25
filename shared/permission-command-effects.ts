import { resolveReadPath } from "./permission-read-paths";

// Only inspect sed program arguments for side effects. A script read from
// another file can contain any command, so its behavior remains executable.
export function sedArguments(args: string[]) {
  const scripts: string[] = [];
  const scriptFiles: string[] = [];
  const files: string[] = [];
  let inPlace = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") { files.push(...args.slice(index + 1)); break; }
    if (arg === "-" || !arg.startsWith("-")) { files.push(arg); continue; }
    // Sed implementations differ on options after a bare operand.
    if (files.length) return null;
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals < 0 ? arg : arg.slice(0, equals);
      if (name === "--in-place") { inPlace = true; continue; }
      if (["--quiet", "--silent", "--regexp-extended"].includes(name) && equals < 0) continue;
      if (name !== "--expression" && name !== "--file") return null;
      const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
      if (value === undefined) return null;
      (name === "--expression" ? scripts : scriptFiles).push(value);
      continue;
    }
    for (let offset = 1; offset < arg.length; offset++) {
      const flag = arg[offset];
      if (flag === "i") {
        inPlace = true;
        // BSD sed accepts a separate backup suffix. A GNU attached suffix is
        // part of this option and is never treated as the program.
        if (offset + 1 === arg.length && (args[index + 1] === "" || /^\.[^/]+$/.test(args[index + 1] ?? ""))) index++;
        break;
      }
      if (flag === "e" || flag === "f") {
        const value = arg.slice(offset + 1) || args[++index];
        if (value === undefined) return null;
        (flag === "e" ? scripts : scriptFiles).push(value);
        break;
      }
      if (!"nEr".includes(flag)) return null;
    }
  }
  if (!scripts.length && !scriptFiles.length && files.length) scripts.push(files.shift()!);
  return { scripts, scriptFiles, files, inPlace };
}

function afterDelimited(source: string, delimiter: string, start: number) {
  for (let index = start; index < source.length; index++) {
    if (source[index] === "\\") index++;
    else if (source[index] === delimiter) return index + 1;
  }
  return -1;
}

export function sedScriptRisk(script: string): "read" | "write" | "execute" | "unknown" {
  let effect: "read" | "write" = "read";
  for (const line of script.split("\n")) {
    let remaining = line.trim();
    while (remaining && !remaining.startsWith("#")) {
      const address = /^(?:(?:\d+|\$|\/(?:[^/\\]|\\.)*\/)(?:\s*,\s*(?:\d+|\$|\/(?:[^/\\]|\\.)*\/))?\s*!?\s*)?/.exec(remaining)![0];
      remaining = remaining.slice(address.length);
      if (remaining.startsWith("e")) return "execute";
      if (/^[wW]/.test(remaining)) { effect = "write"; break; }
      if (remaining.startsWith("s") && remaining.length > 2) {
        const delimiter = remaining[1];
        const replacement = afterDelimited(remaining, delimiter, 2);
        const end = replacement >= 0 ? afterDelimited(remaining, delimiter, replacement) : -1;
        if (end < 0) return "unknown";
        const rest = remaining.slice(end).trimStart();
        const flags = /^[a-zA-Z0-9]*/.exec(rest)![0];
        if (flags.includes("e")) return "execute";
        if (flags.includes("w")) { effect = "write"; break; }
        if (!/^[gp0-9]*$/.test(flags)) return "unknown";
        remaining = rest.slice(flags.length).trimStart();
      } else if (/^[pPdDnNl=](?=\s|;|$)/.test(remaining)) {
        remaining = remaining.slice(1).trimStart();
      } else return "unknown";
      if (remaining && !remaining.startsWith(";")) return "unknown";
      remaining = remaining.slice(1).trimStart();
    }
  }
  return effect;
}

const curlValueOptions = new Set(["--url", "--url-query", "--header", "--user", "--data", "--data-raw", "--data-binary",
  "--data-urlencode", "--form", "--form-string", "--request", "--config", "--proxy",
  "--cacert", "--cert", "--key", "--cookie", "--user-agent", "--referer", "--max-time", "--connect-timeout", "--retry",
  "--write-out", "--resolve", "--connect-to", "--interface", "--request-target", "--proto", "--proto-redir"]);

export function curlFileOutput(args: string[]) {
  let writes = false;
  let remoteName = false;
  let directory: string | undefined;
  let destinations: string[] = [];
  let cookieJar: string | undefined;
  let headerDump: string | undefined;
  const files: string[] = [];
  const setDestination = (option: string, file: string | undefined) => {
    if (!file) return;
    if (option === "-c" || option === "--cookie-jar") cookieJar = file;
    else if (option === "-D" || option === "--dump-header") headerDump = file;
    else if (file !== "-") destinations.push(file);
  };
  const finishTransfer = () => {
    const auxiliary = [cookieJar, headerDump].filter((file): file is string => !!file && file !== "-");
    writes ||= remoteName || destinations.length > 0 || auxiliary.length > 0;
    files.push(...destinations.map(file => directory ? resolveReadPath(file, directory) : file), ...auxiliary);
    if (directory && remoteName && !destinations.length) files.push(directory);
    directory = undefined;
    destinations = [];
    remoteName = false;
    cookieJar = undefined;
    headerDump = undefined;
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") break;
    if (arg === "--next" || arg === "-:") { finishTransfer(); continue; }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals < 0 ? arg : arg.slice(0, equals);
      if (name === "--remote-name" || name === "--remote-name-all") remoteName = true;
      if (name === "--output" || name === "--cookie-jar" || name === "--dump-header") {
        const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
        setDestination(name, value);
      } else if (name === "--output-dir") {
        directory = equals < 0 ? args[++index] : arg.slice(equals + 1);
      } else if (equals < 0 && curlValueOptions.has(name)) index++;
    } else if (arg.startsWith("-")) {
      for (let offset = 1; offset < arg.length; offset++) {
        const option = arg[offset];
        if (option === "O") remoteName = true;
        if (option === "o" || option === "c" || option === "D") {
          const value = arg.slice(offset + 1) || args[++index];
          setDestination("-" + option, value);
          break;
        }
        if ("AbCdeEFHKmPQrTuxXUYywz".includes(option)) {
          if (offset + 1 === arg.length) index++;
          break;
        }
      }
    }
  }
  finishTransfer();
  return { writes, files };
}
