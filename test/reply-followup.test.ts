import {expect, test} from 'bun:test';
import {FOLLOWUP_WINDOW_MS, KANBAN_ORDER, elapsedLabel, followupKind, hostWideVisible, recipientGone, recipientLink} from '../client/reply-followup';
import {historySessionLinks, type HistorySession} from '../client/history-sessions';
import type {ReplyEntry} from '../shared/reply-history';

const now = Date.parse('2026-11-24T12:00:00Z');
const hoursAgo = (hours:number) => new Date(now - hours * 3600_000).toISOString();
const sent:ReplyEntry = {key:'one',status:'sent',title:'Which draft?',projectId:'alpha',at:hoursAgo(23),answer:'Use the second draft.',
  recipientId:'worker-1',recipientTitle:'Draft session',canOpen:true};
const directory = {hostId:'studio',sessions:[],repos:new Map<string,string>(),peers:[]};
const kind = (entry:ReplyEntry) => followupKind(entry, historySessionLinks(entry, directory), now);
const ko = (korean:string) => korean;
const en = (_:string, english:string) => english;

test('a sent reply with no follow-up stays on the board for 24 hours', () => {
  expect(FOLLOWUP_WINDOW_MS).toBe(24 * 3600_000);
  expect(kind(sent)).toBe('waiting');
  expect(kind({...sent,at:hoursAgo(25)})).toBeNull();
  expect(kind({...sent,at:new Date(now - FOLLOWUP_WINDOW_MS).toISOString()})).toBeNull();
  expect(kind({...sent,at:'not a date'})).toBeNull();
});

test('a reply leaves the board once the session answers', () => {
  expect(kind({...sent,response:'Done. Second draft is live.'})).toBeNull();
});

test('a reply awaiting delivery confirmation also waits on the board', () => {
  expect(kind({...sent,status:'pending'})).toBe('waiting');
});

test('a reply whose recipient is gone moves to history only', () => {
  const gone = {...sent,canOpen:undefined,recipientTitle:undefined};
  expect(kind(gone)).toBeNull();
  expect(recipientGone(gone, historySessionLinks(gone, directory))).toBe(true);
  expect(recipientGone(sent, historySessionLinks(sent, directory))).toBe(false);
  // A session that is still listed on this host is not gone, even without canOpen.
  const listed = {...directory,sessions:[{id:'worker-1',projectId:'alpha',title:'Draft session',status:'idle' as const,lane:'idle' as const}]};
  expect(recipientGone(gone, historySessionLinks(gone, listed))).toBe(false);
  expect(followupKind(gone, historySessionLinks(gone, listed), now)).toBe('waiting');
});

test('a recipient still being checked on another host is not reported as gone', () => {
  const checking:HistorySession[] = [{role:'received',id:'worker-1',host:'laptop',available:false,verify:async () => true}];
  expect(recipientGone(sent, checking)).toBe(false);
  expect(followupKind(sent, checking, now)).toBe('waiting');
  expect(recipientGone(sent, [{role:'received',id:'worker-1',host:'laptop',available:false}])).toBe(true);
});

test('the gone notice is only for sent replies with a recipient', () => {
  expect(recipientGone({...sent,status:'recorded',canOpen:undefined}, [{role:'target',id:'worker-1',available:false}])).toBe(false);
  expect(recipientGone({...sent,recipientId:undefined}, [{role:'source',id:'worker-1',available:false}])).toBe(false);
  expect(recipientLink([{role:'source',id:'a',available:true},{role:'received',id:'b',available:true}])?.id).toBe('b');
});

test('a reply that could not be sent stays on the board for 24 hours, even without a recipient', () => {
  expect(kind({...sent,status:'unsent'})).toBe('unsent');
  expect(kind({...sent,status:'unsent',recipientId:undefined,canOpen:undefined})).toBe('unsent');
  expect(kind({...sent,status:'unsent',at:hoursAgo(25)})).toBeNull();
});

test('records, closed replies and merge receipts never wait on the board', () => {
  expect(kind({...sent,status:'recorded'})).toBeNull();
  expect(kind({...sent,status:'closed'})).toBeNull();
  expect(kind({...sent,recipientId:undefined,canOpen:undefined})).toBeNull();
});

test('elapsed time reads naturally in both languages', () => {
  expect(elapsedLabel(20_000, ko)).toBe('방금');
  expect(elapsedLabel(-5_000, en)).toBe('just now');
  expect(elapsedLabel(5 * 60_000, ko)).toBe('5분 전');
  expect(elapsedLabel(5 * 60_000, en)).toBe('5 min ago');
  expect(elapsedLabel(3 * 3600_000 + 59 * 60_000, ko)).toBe('3시간 전');
  expect(elapsedLabel(1 * 3600_000, en)).toBe('1 hr ago');
  expect(elapsedLabel(23 * 3600_000, en)).toBe('23 hr ago');
  expect(elapsedLabel(49 * 3600_000, ko)).toBe('2일 전');
  expect(elapsedLabel(49 * 3600_000, en)).toBe('2 days ago');
  expect(elapsedLabel(25 * 3600_000, en)).toBe('1 day ago');
});

test('project kanban has no history column', () => {
  expect(KANBAN_ORDER).toEqual(['running','review','human','idle','done','unknown']);
  expect(KANBAN_ORDER as readonly string[]).not.toContain('history');
});

test('the host-wide section is hidden when it has nothing to show', () => {
  expect(hostWideVisible({records:0,followups:0})).toBe(false);
  expect(hostWideVisible({records:1,followups:0})).toBe(true);
  expect(hostWideVisible({records:0,followups:1})).toBe(true);
});
