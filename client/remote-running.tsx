import { getPaseoClient, useHosts, useSettings } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { boardHosts, hostVisibility, type BoardHost } from "../shared/hosts";
import { readRemoteSessions, remoteScope, type LocalProject, type RemoteSession, type RemoteWaitCache, type Repository } from "./remote-sessions";
import { SessionChip, type Theme } from "./controls";
import { useBoardLanguage } from "./language";

type Open = (serverId: string, sessionId: string) => void;
export type RemoteGroup = { host: BoardHost; rows: RemoteSession[]; failed: boolean };

export function useRemoteRunning(current: {id:string;label:string}, projects:LocalProject[], repositories:Repository[],
  enabled:boolean, skipWait:(host:string,id:string)=>boolean) {
  const hosts = useHosts();
  const visibility = useSettings(hostVisibility);
  const scope = remoteScope(projects, repositories);
  const registered = enabled && scope.selected.length && visibility.status === "ready"
    ? boardHosts(current, hosts).filter(host => host.serverId !== current.id && host.status === "online" && !visibility.values.hidden.includes(host.serverId))
      .map(host => ({ ...host, registeredLabel: hosts.find(entry => entry.serverId === host.serverId)?.label ?? host.label }))
    : [];
  const key = JSON.stringify([current.id, scope, registered.map(h => [h.serverId,h.label])]);
  const [cache, setCache] = useState<{key:string; groups:RemoteGroup[]}>({key:"", groups:[]});
  const skip = useRef(skipWait);
  skip.current = skipWait;
  useEffect(() => {
    let active = true;
    const timers = registered.map(host => {
      let pending = false;
      const waits: RemoteWaitCache = new Map();
      function publish(group: RemoteGroup, initial = false) {
        if (!active) return;
        setCache(previous => {
          if (!active) return previous;
          const groups = previous.key === key ? previous.groups : [];
          if (initial && groups.some(group => group.host.serverId === host.serverId)) return previous;
          return { key, groups: [...groups.filter(group => group.host.serverId !== host.serverId), group] };
        });
      }
      async function refresh() {
        if (pending) return;
        pending = true;
        let group:RemoteGroup;
        try {
          const rows = await readRemoteSessions(getPaseoClient(host.serverId), scope, () => active, {
            cache: waits, skipWait: id => skip.current(host.serverId, id),
            onRunning: rows => publish({host, rows, failed:false}, true),
          });
          group = {host, rows, failed:false};
        } catch {
          group = {host, rows:[], failed:true};
        } finally { pending = false; }
        publish(group);
      }
      void refresh();
      return setInterval(() => void refresh(), 30_000);
    });
    return () => { active = false; timers.forEach(clearInterval); };
  }, [key]);
  const groups = cache.key === key ? cache.groups : [];
  return { groups, hosts: registered, loading: enabled && (visibility.status === "loading" || groups.length < registered.length) };
}

type ViewProps = {projects:LocalProject[];theme:Theme;open?:Open};

export function RemoteRunning({groups, ...props}: ViewProps & {groups:RemoteGroup[]}) {
  return <>{groups.map(group => <HostRunning key={group.host.serverId} {...group} {...props} />)}</>;
}

function HostRunning({ host, rows, failed, projects, theme, open }: RemoteGroup & ViewProps) {
  const {t} = useBoardLanguage();
  const c = theme.colors;
  if (failed) return <Text style={{color:c.foregroundMuted}}>{t(`${host.label} · 진행 중인 세션 조회 실패`,`${host.label} · Could not load running sessions`)}</Text>;
  const running = rows.filter(row => !row.wait);
  if (!running.length) return null;
  return <View style={{gap:6,borderWidth:1,borderColor:c.border,borderRadius:10,padding:12}}>
    <Text accessibilityRole="header" style={{color:c.foreground,fontWeight:"600"}}>{t(`${host.label} · 진행 중인 세션`,`${host.label} · Running sessions`)}</Text>
    {running.map(row => {
      const project = projects.find(p => p.id===row.projectId);
      if (!project?.selected) return null;
      const title = row.title || t(`세션 ${row.sessionId.slice(0,8)}`,`Session ${row.sessionId.slice(0,8)}`);
      return <View key={row.sessionId} style={{flexDirection:"row",flexWrap:"wrap",alignItems:"center",gap:6}}>
        <Text selectable style={{flexGrow:1,flexShrink:1,color:c.foreground}}>{project.title} · {title}</Text>
        {open && <SessionChip theme={theme} label={t("작업 세션","Work session")}
          accessibilityLabel={t(`${host.label} · ${title} 열기`,`Open ${title} on ${host.label}`)} onPress={() => open(host.serverId,row.sessionId)} />}
      </View>;
    })}
  </View>;
}
