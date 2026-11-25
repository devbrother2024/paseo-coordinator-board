import { expect, test } from "bun:test";
import {
  assignmentHost, inferHostPlatform, pairedProject, workspacePathIsAbsolute,
  type AssignmentHost, type HostProject,
} from "../shared/host-assignment";

const mac: AssignmentHost = {
  id: "mac-host", label: "Mac", local: true, online: true,
  enabled: true, platform: "mac", running: 2, limit: null, workspaces: ["mac-space"],
};
const win: AssignmentHost = {
  id: "win-host", label: "Windows", local: false, online: true,
  enabled: true, platform: "windows", running: 0, limit: null, workspaces: ["win-space"],
};

test("a required OS or named host cannot fall back to a different host", () => {
  expect(assignmentHost([mac, win], { platform: "mac" })).toMatchObject({ host: mac });
  expect(assignmentHost([mac, win], { platform: "any", host: "windows" })).toMatchObject({ host: win });
  expect(assignmentHost([mac], { platform: "windows" })).toEqual({ failure: "platform-offline" });
  const offline = { ...win, online: false, running: null };
  expect(assignmentHost([mac, offline], { platform: "windows" })).toEqual({ failure: "platform-offline" });
  expect(assignmentHost([mac, offline], { platform: "any", host: "Windows" })).toEqual({ failure: "host-offline" });
  expect(assignmentHost([mac, win], { platform: "mac", host: "Windows" })).toEqual({ failure: "platform-offline" });
  expect(assignmentHost([mac, win], { platform: "any", host: "Unknown" })).toEqual({ failure: "host-unknown" });
  expect(assignmentHost([mac, win, { ...win, id: "other-win" }], { platform: "any", host: "Windows" })).toEqual({ failure: "host-unknown" });
});

test("any uses the least busy host with a workspace, breaking ties in favor of the board", () => {
  expect(assignmentHost([mac], { platform: "any" })).toMatchObject({ host: mac });
  expect(assignmentHost([mac, win], { platform: "any" })).toMatchObject({ host: win });
  expect(assignmentHost([{ ...win, running: 2 }, mac], { platform: "any" })).toMatchObject({ host: mac });
  expect(assignmentHost([mac, { ...win, workspaces: [] }], { platform: "any" })).toMatchObject({ host: mac });
  expect(assignmentHost([mac, { ...win, enabled: false }], { platform: "any" })).toMatchObject({ host: mac });
  expect(assignmentHost([mac, { ...win, running: 1, limit: 1 }], { platform: "windows" })).toEqual({ failure: "at-capacity" });
  expect(assignmentHost([mac, { ...win, workspaces: [] }], { platform: "windows" })).toEqual({ failure: "project-unavailable" });
  expect(assignmentHost([mac, { ...win, running: null }], { platform: "windows" })).toEqual({ failure: "load-unavailable" });
  expect(assignmentHost([mac, win], { platform: "any", expectedHostId: mac.id })).toMatchObject({ host: mac });
});

test("Windows drive and share paths work and unknown or conflicting path evidence stays unknown", () => {
  expect(inferHostPlatform({}, ["C:\\work\\alpha"])).toBe("windows");
  expect(inferHostPlatform({}, ["\\\\fileserver\\share\\alpha"])).toBe("windows");
  expect(inferHostPlatform({}, ["/Users/you/projects/alpha"])).toBe("mac");
  expect(inferHostPlatform({}, ["/home/you/alpha"])).toBe("linux");
  expect(inferHostPlatform({}, ["/srv/alpha"])).toBeNull();
  expect(inferHostPlatform({}, ["/home/you/alpha", "C:\\work\\alpha"])).toBeNull();
  expect(inferHostPlatform({ os: "darwin" }, [])).toBe("mac");
  expect(workspacePathIsAbsolute("C:relative")).toBe(false);
  expect(workspacePathIsAbsolute("\\root-relative")).toBe(false);
  expect(workspacePathIsAbsolute("D:\\projects\\alpha")).toBe(true);
});

test("explicit project pairs win, then a unique repository or name without conflicting evidence", () => {
  const source: HostProject = { id: "alpha-mac", name: "Alpha", repos: ["github.com/example/alpha"] };
  const same: HostProject = { id: "alpha-win", name: "Renamed checkout", repos: ["github.com/example/alpha"] };
  const name: HostProject = { id: "alpha-by-name", name: "alpha", repos: [] };
  const different: HostProject = { id: "alpha-fork", name: "Alpha", repos: ["github.com/example/fork"] };
  expect(pairedProject(source, [same, name, different])).toBe(same);
  expect(pairedProject(source, [same, name], name.id)).toBe(name);
  expect(pairedProject(source, [same, name], "missing")).toBeNull();
  expect(pairedProject(source, [same, { ...same, id: "second-clone" }, name])).toBeNull();
  expect(pairedProject(source, [name, different])).toBe(name);
  expect(pairedProject(source, [different])).toBeNull();
  expect(pairedProject(source, [name, { ...name, id: "ambiguous" }])).toBeNull();
});
