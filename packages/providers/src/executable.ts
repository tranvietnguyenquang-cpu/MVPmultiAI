import { access, realpath } from "node:fs/promises";
import path from "node:path";

export type ResolvedExecutable = { command: string; canonicalPath: string };
type ResolverOptions = { platform?: NodeJS.Platform; pathValue?: string; accessFile?: (path:string)=>Promise<void>; canonicalize?: (path:string)=>Promise<string> };

export async function resolveCliExecutable(command:"codex"|"claude",options:ResolverOptions={}):Promise<ResolvedExecutable|undefined>{
  const platform=options.platform??process.platform;const accessFile=options.accessFile??(candidate=>access(candidate));const canonicalize=options.canonicalize??realpath;const pathValue=options.pathValue??process.env.PATH??"";
  const extensions=platform==="win32"?[".exe",".cmd"]:[""];const names=extensions.map(extension=>`${command}${extension}`);const candidates=pathValue.split(path.delimiter).filter(Boolean).flatMap(folder=>names.map(name=>path.join(folder,name)));
  for(const candidate of candidates){try{await accessFile(candidate);return{command,canonicalPath:await canonicalize(candidate)};}catch{}}
  return undefined;
}
