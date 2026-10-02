"use client";

// lib/chat-unread.ts
// 聊天未读计数：给桌面「聊天」图标右上角的红点提供数字。
//
// 为什么不复用 ChatSession.unreadCount：那个字段只在类型里定义过，全仓没有
// 写入点也没有渲染点（遗留字段），语义是空的。这里自己维护一套：
//   · 每个会话记一条「最后已读位置」（该会话最后一条可见消息的 order）；
//   · 未读数 = 该位置之后、由角色发来的可见消息条数；
//   · 打开聊天 App 时把全部会话标记为已读（微信式：进了 App 就算看过）。
//
// 首次启用时做一次基线初始化：把当时各会话的最后一条消息记为「已读」，避免
// 装上功能的第一眼就把历史聊天全算成未读、红点顶着几百条。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import {
  loadChatSessions,
  loadChatMessages,
  getChatMessagePreview,
  type ChatMessage,
} from "./chat-storage";

export const CHAT_UNREAD_CHANGED_EVENT = "ai-chat-unread-changed";

const READ_STATE_KEY = "ai_phone_chat_read_state_v1";
const BASELINE_KEY = "ai_phone_chat_unread_baseline_v1";
registerKvMigration(READ_STATE_KEY);
registerKvMigration(BASELINE_KEY);

/** sessionId → 该会话最后一条已读消息的 order */
type ReadState = Record<string, number>;

function loadReadState(): ReadState {
  if (typeof window === "undefined") return {};
  try {
    const raw = kvGet(READ_STATE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const state: ReadState = {};
    for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const order = Number(value);
      if (sessionId && Number.isFinite(order)) state[sessionId] = order;
    }
    return state;
  } catch {
    return {};
  }
}

function saveReadState(state: ReadState): void {
  if (typeof window === "undefined") return;
  kvSet(READ_STATE_KEY, JSON.stringify(state));
}

function dispatchUnreadChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHAT_UNREAD_CHANGED_EVENT));
}

/** 这条消息算不算一条「值得提示的未读」：角色发来的可见内容。 */
function isUnreadCandidate(msg: ChatMessage): boolean {
  if (msg.role !== "assistant") return false;
  if (msg.isRetracted) return false;
  if (msg.origin === "reading_discuss") return false;
  if (
    msg.mediaType === "tool_call"
    || msg.mediaType === "tool_result"
    || msg.mediaType === "tool_notice"
  ) return false;
  // 与列表预览同口径：连预览都产不出的（纯内部记录）不该顶红点。
  if (!getChatMessagePreview(msg).trim() && !msg.content.trim()) return false;
  return true;
}

function messageOrder(msg: ChatMessage): number | null {
  // 只用 order：会话内它是单调稳定的（chat-storage 的 reindex 保证）。
  // 不拿时间戳兜底——order 是 0..n 的小整数、时间戳是 13 位，混在同一个
  // 基线里比较会彻底错位（基线存的是 order）。没有 order 的极老数据跳过即可。
  return typeof msg.order === "number" && Number.isFinite(msg.order) ? msg.order : null;
}

/** 该会话最后一条可见消息的 order（一条可见消息都没有时返回 null）。 */
function lastVisibleOrder(sessionId: string): number | null {
  const messages = loadChatMessages(sessionId);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const order = messageOrder(messages[i]);
    if (order !== null) return order;
  }
  return null;
}

/**
 * 首次启用时打基线：把当前各会话的最后一条消息记为已读。
 * 只做一次，之后靠 markAllChatRead / markSessionChatRead 推进已读位置。
 */
export function ensureChatUnreadBaseline(): void {
  if (typeof window === "undefined") return;
  if (kvGet(BASELINE_KEY) === "1") return;
  const state = loadReadState();
  for (const session of loadChatSessions()) {
    if (state[session.id] !== undefined) continue;
    const order = lastVisibleOrder(session.id);
    if (order !== null) state[session.id] = order;
  }
  saveReadState(state);
  kvSet(BASELINE_KEY, "1");
}

/**
 * 单个会话的未读数：已读位置之后、角色发来的可见消息条数。
 * 从尾部往前扫，碰到已读位置就停，所以正常情况只走几条。
 */
export function getSessionChatUnreadCount(sessionId: string, state = loadReadState()): number {
  // 没记过已读位置的会话（基线之后才建出来的新会话）按「一条都没读」算：
  // 退回 -1 而不是 0，否则新会话的首条招呼消息会被显示成 0 条未读、红标不亮。
  const baseline = state[sessionId] ?? -1;
  const messages = loadChatMessages(sessionId);
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const order = messageOrder(msg);
    if (order === null) continue;
    if (order <= baseline) break;
    if (isUnreadCandidate(msg)) count += 1;
  }
  return count;
}

/**
 * 所有会话的未读数一次性算完（列表页逐行显示用）。
 * 只读一次已读状态、只遍历一次会话，避免列表里 N 行各读一次。
 */
export function getChatUnreadBySession(): Record<string, number> {
  if (typeof window === "undefined") return {};
  ensureChatUnreadBaseline();
  const state = loadReadState();
  const result: Record<string, number> = {};
  for (const session of loadChatSessions()) {
    const count = getSessionChatUnreadCount(session.id, state);
    if (count > 0) result[session.id] = count;
  }
  return result;
}

/** 全部会话的未读总数（桌面图标红点用）。 */
export function getTotalChatUnreadCount(): number {
  if (typeof window === "undefined") return 0;
  ensureChatUnreadBaseline();
  const state = loadReadState();
  let total = 0;
  for (const session of loadChatSessions()) {
    total += getSessionChatUnreadCount(session.id, state);
  }
  return total;
}

/** 把某个会话标记为已读（进到该会话时用）。 */
export function markSessionChatRead(sessionId: string): void {
  if (!sessionId) return;
  const state = loadReadState();
  const order = lastVisibleOrder(sessionId);
  if (order !== null) state[sessionId] = order;
  saveReadState(state);
  dispatchUnreadChanged();
}

/** 把所有会话标记为已读（打开聊天 App 时用，微信式：进 App 即清）。 */
export function markAllChatRead(): void {
  if (typeof window === "undefined") return;
  const state = loadReadState();
  for (const session of loadChatSessions()) {
    const order = lastVisibleOrder(session.id);
    if (order !== null) state[session.id] = order;
  }
  saveReadState(state);
  dispatchUnreadChanged();
}

/** 丢弃已不存在的会话的已读记录，避免记录无限增长。 */
export function pruneChatReadState(): void {
  if (typeof window === "undefined") return;
  const state = loadReadState();
  const alive = new Set(loadChatSessions().map(session => session.id));
  let changed = false;
  for (const sessionId of Object.keys(state)) {
    if (alive.has(sessionId)) continue;
    delete state[sessionId];
    changed = true;
  }
  if (changed) saveReadState(state);
}