/*
 * Copyright (C) 2011 Google Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Google Inc. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

/* eslint-disable rulesdir/no_underscored_properties */

import {NodeURL} from './NodeURL.js';
import * as Host from '../host/host.js';
import type * as ProtocolProxyApi from '../../generated/protocol-proxy-api.js';
import * as Protocol from '../../generated/protocol.js';

export const DevToolsStubErrorCode = -32015;
// TODO(dgozman): we are not reporting generic errors in tests, but we should
// instead report them and just have some expected errors in test expectations.
const GenericError = -32000;
const ConnectionClosedErrorCode = -32001;

type MessageParams = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [x: string]: any,
};

type ProtocolDomainName = ProtocolProxyApi.ProtocolDomainName;

export interface MessageError {
  code: number;
  message: string;
  data?: string|null;
}

// params may be compressed into a string
export type Message = {
  sessionId?: string,
  url?: string,
  id?: number,
  error?: MessageError|null,
  result?: Object|null,
  domain?: string,
  method?: QualifiedName,
  params?: MessageParams | string | null,
  timestamp?: number
};

// params may be compressed into a string
interface EventMessage extends Message {
  method: QualifiedName;
  compress?: boolean;
  params?: MessageParams | string | null;
}


/** A qualified name, e.g. Domain.method */
export type QualifiedName = string&{qualifiedEventNameTag: string | undefined};
/** A qualified name, e.g. method */
export type UnqualifiedName = string&{unqualifiedEventNameTag: string | undefined};

export const splitQualifiedName = (string: QualifiedName): [string, UnqualifiedName] => {
  const [domain, eventName] = string.split('.');
  return [domain, eventName as UnqualifiedName];
};

export const qualifyName = (domain: string, name: UnqualifiedName): QualifiedName => {
  return `${domain}.${name}` as QualifiedName;
};

type EventParameterNames = Map<QualifiedName, string[]>;
type ReadonlyEventParameterNames = ReadonlyMap<QualifiedName, string[]>;

interface CommandParameter {
  name: string;
  type: string;
  optional: boolean;
}

type Callback = (error: MessageError|null, arg1: Object|null) => void;

interface CallbackWithDebugInfo {
  callback: Callback;
  method: string;
}

export const postPluginMessage = (name: string, msg: string | Record<string, any>) => {
  // @ts-ignore
  window.postPluginMessage?.(name)(`Extensions.${name}`, msg);
}
export const addPluginEventListener = (name: string, listener: (msg: any) => void) => {
  // @ts-ignore
  window.addPluginEventListener?.(name)(`Extensions.${name}`, listener);
}

export enum LevelType {
  Info = 'info',
  Debug = 'debug',
  Error = 'error',
  Warn = 'warn',
}
export interface EnvLogCategoryObject {
  tag: string; // secondary tags
  timestamp?: number; // timestamp, if not transmitted, it will be generated during log
  extra?: Record<string, any>; // any additional tags
}
interface EnvLogObject {
  level: LevelType;
  module: string;
  tag: string;
  msg: string | Record<string, any>;
  // millisecond timestamp
  timestamp: number;
  extra?: Record<string, any>;
}
class EnvLogger {
  // log methods
  debug(msg: Record<string, any> | string, categories: EnvLogCategoryObject) {
    this.log(LevelType.Debug, msg, categories);
  }
  info(msg: Record<string, any> | string, categories: EnvLogCategoryObject) {
    this.log(LevelType.Info, msg, categories);
  }
  warn(msg: Record<string, any> | string, categories: EnvLogCategoryObject) {
    this.log(LevelType.Warn, msg, categories);
  }
  error(msg: Record<string, any> | string, categories: EnvLogCategoryObject) {
    this.log(LevelType.Error, msg, categories);
  }
  log(level: LevelType, msg: Record<string, any> | string, categories: EnvLogCategoryObject) {
    const logObj = this._assembleEnvLogObject(level, msg, categories);
    Host.InspectorFrontendHost.sendWindowMessage({
      type: 'addEnvLog',
      content: logObj
    });
  }

  // utils
  private _assembleEnvLogObject(
    level: LevelType,
    msg: Record<string, any> | string,
    categories: EnvLogCategoryObject
  ): EnvLogObject {
    const { tag, timestamp = Date.now(), extra = {} } = categories;
    return {
      level,
      module: 'Devtool',
      tag,
      msg,
      timestamp,
      extra
    };
  }
}
export const envLogger = new EnvLogger();

export class InspectorBackend {
  _agentPrototypes: Map<ProtocolDomainName, _AgentPrototype> = new Map();
  private initialized: boolean = false;
  private eventParameterNamesForDomain = new Map<ProtocolDomainName, EventParameterNames>();

  private getOrCreateEventParameterNamesForDomain(domain: ProtocolDomainName): EventParameterNames {
    let map = this.eventParameterNamesForDomain.get(domain);
    if (!map) {
      map = new Map();
      this.eventParameterNamesForDomain.set(domain, map);
    }
    return map;
  }

  getOrCreateEventParameterNamesForDomainForTesting(domain: ProtocolDomainName): EventParameterNames {
    return this.getOrCreateEventParameterNamesForDomain(domain);
  }

  getEventParamterNames(): ReadonlyMap<ProtocolDomainName, ReadonlyEventParameterNames> {
    return this.eventParameterNamesForDomain;
  }

  static reportProtocolError(error: string, messageObject: Object): void {
    // TODO: suppress protocol error temporarily.
    // console.error(error + ': ' + JSON.stringify(messageObject));
  }

  static reportProtocolWarning(error: string, messageObject: Object): void {
    console.warn(error + ': ' + JSON.stringify(messageObject));
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  _agentPrototype(domain: ProtocolDomainName): _AgentPrototype {
    let prototype = this._agentPrototypes.get(domain);
    if (!prototype) {
      prototype = new _AgentPrototype(domain);
      this._agentPrototypes.set(domain, prototype);
    }
    return prototype;
  }

  registerCommand(method: QualifiedName, parameters: CommandParameter[], replyArgs: string[]): void {
    const [domain, command] = splitQualifiedName(method);
    this._agentPrototype(domain as ProtocolDomainName).registerCommand(command, parameters, replyArgs);
    this.initialized = true;
  }

  registerEnum(type: QualifiedName, values: Object): void {
    const [domain, name] = splitQualifiedName(type);
    // @ts-ignore Protocol global namespace pollution
    if (!Protocol[domain]) {
      // @ts-ignore Protocol global namespace pollution
      Protocol[domain] = {};
    }

    // @ts-ignore Protocol global namespace pollution
    Protocol[domain][name] = values;
    this.initialized = true;
  }

  registerEvent(eventName: QualifiedName, params: string[]): void {
    const domain = eventName.split('.')[0];
    const eventParameterNames = this.getOrCreateEventParameterNamesForDomain(domain as ProtocolDomainName);
    eventParameterNames.set(eventName, params);
    this.initialized = true;
  }
}

let connectionFactory: () => Connection;

export class Connection {
  _onMessage!: ((arg0: Object) => void)|null;
  constructor() {
  }

  setOnMessage(_onMessage: (arg0: (Object|string)) => void): void {
  }

  setOnDisconnect(_onDisconnect: (arg0: string) => void): void {
  }

  sendRawMessage(_message: string): void {
  }

  disconnect(): Promise<void> {
    throw new Error('not implemented');
  }

  static setFactory(factory: () => Connection): void {
    connectionFactory = factory;
  }

  static getFactory(): () => Connection {
    return connectionFactory;
  }
}

type SendRawMessageCallback = (...args: unknown[]) => void;  // eslint-disable-line no-unused-vars

export const test = {
  /**
   * This will get called for every protocol message.
   * ProtocolClient.test.dumpProtocol = console.log
   */
  dumpProtocol: null as ((arg0: string) => void) | null,

  /**
   * Runs a function when no protocol activity is present.
   * ProtocolClient.test.deprecatedRunAfterPendingDispatches(() => console.log('done'))
   */
  deprecatedRunAfterPendingDispatches: null as ((arg0: () => void) => void) | null,

  /**
   * Sends a raw message over main connection.
   * ProtocolClient.test.sendRawMessage('Page.enable', {}, console.log)
   */
  sendRawMessage: null as ((method: QualifiedName, args: Object|null, arg2: SendRawMessageCallback) => void) | null,

  /**
   * Set to true to not log any errors.
   */
  suppressRequestErrors: false as boolean,

  /**
   * Set to get notified about any messages sent over protocol.
   */
  onMessageSent: null as
          ((message: {domain: string, method: string, params: Object, id: number, sessionId?: string},
            target: TargetBase|null) => void) |
      null,

  /**
   * Set to get notified about any messages received over protocol.
   */
  onMessageReceived: null as ((message: Object, target: TargetBase|null) => void) | null,
};

const LongPollingMethods = new Set<string>(['CSS.takeComputedStyleUpdates']);

export class SessionRouter {
  _connection: Connection;
  _lastMessageId: number;
  _pendingResponsesCount: number;
  _pendingLongPollingMessageIds: Set<number>;
  _sessions: Map<string, {
    target: TargetBase,
    callbacks: Map<number, CallbackWithDebugInfo>,
    proxyConnection: ((Connection | undefined)|null),
  }>;
  _pendingScripts: (() => void)[];

  constructor(connection: Connection) {
    this._connection = connection;
    this._lastMessageId = 1;
    this._pendingResponsesCount = 0;
    this._pendingLongPollingMessageIds = new Set();

    this._sessions = new Map();

    this._pendingScripts = [];

    test.deprecatedRunAfterPendingDispatches = this._deprecatedRunAfterPendingDispatches.bind(this);
    test.sendRawMessage = this._sendRawMessageForTesting.bind(this);

    this._connection.setOnMessage(this._onMessage.bind(this));

    this._connection.setOnDisconnect(reason => {
      const session = this._sessions.get('');
      if (session) {
        session.target.dispose(reason);
      }
    });
  }

  registerSession(target: TargetBase, sessionId: string, proxyConnection?: Connection|null): void {
    // Only the Audits panel uses proxy connections. If it is ever possible to have multiple active at the
    // same time, it should be tested thoroughly.
    if (proxyConnection) {
      for (const session of this._sessions.values()) {
        if (session.proxyConnection) {
          console.error('Multiple simultaneous proxy connections are currently unsupported');
          break;
        }
      }
    }

    this._sessions.set(sessionId, {target, callbacks: new Map(), proxyConnection});
  }

  unregisterSession(sessionId: string): void {
    const session = this._sessions.get(sessionId);
    if (!session) {
      return;
    }
    for (const callback of session.callbacks.values()) {
      SessionRouter.dispatchUnregisterSessionError(callback);
    }
    this._sessions.delete(sessionId);
  }

  _getTargetBySessionId(sessionId: string): TargetBase|null {
    const session = this._sessions.get(sessionId ? sessionId : '');
    if (!session) {
      return null;
    }
    return session.target;
  }

  _nextMessageId(): number {
    return this._lastMessageId++;
  }

  connection(): Connection {
    return this._connection;
  }

  sendMessage(sessionId: string, domain: string, method: QualifiedName, params: Object|null, callback: Callback): void {
    const messageId = this._nextMessageId();
    const messageObject: Message = {
      id: messageId,
      method: method,
    };

    if (params) {
      messageObject.params = params;
    }
    if (sessionId) {
      messageObject.sessionId = sessionId;
    }

    if (test.dumpProtocol) {
      test.dumpProtocol('frontend: ' + JSON.stringify(messageObject));
    }

    if (test.onMessageSent) {
      const paramsObject = JSON.parse(JSON.stringify(params || {}));
      test.onMessageSent(
          {domain, method, params: (paramsObject as Object), id: messageId, sessionId},
          this._getTargetBySessionId(sessionId));
    }

    ++this._pendingResponsesCount;
    if (LongPollingMethods.has(method)) {
      this._pendingLongPollingMessageIds.add(messageId);
    }

    const session = this._sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.callbacks.set(messageId, {callback, method});
    messageObject.timestamp = Date.now();
    this._connection.sendRawMessage(JSON.stringify(messageObject));
    // console.group('Message Debug');
    // console.log('sendMessage(...) InspectorBackend.ts - 360');
    // console.log(messageObject);
    // console.groupEnd();
    // when web sends a message, send devtool message statistics to iframe
    // @ts-ignore
    if (window.devtoolStatsRecording || window.devtoolStatsRecording === undefined) {
      Host.InspectorFrontendHost.sendWindowMessage({
        type: 'devtool_stats',
        content: {
          type: 'stats_message',
          message: {
            sender: 'web',
            type: 'CDP',
            message: JSON.stringify(messageObject),
            timestamp: Date.now(),
          },
        }
      });
    }
  }

  _sendRawMessageForTesting(method: QualifiedName, params: Object|null, callback: Callback|null): void {
    const domain = method.split('.')[0];
    this.sendMessage('', domain, method, params, callback || ((): void => {}));
  }

  // This method is called by Connection as an event handler
  _onMessage(message: string|Object): void {
    if (test.dumpProtocol) {
      test.dumpProtocol('backend: ' + ((typeof message === 'string') ? message : JSON.stringify(message)));
    }

    if (test.onMessageReceived) {
      const messageObjectCopy = JSON.parse((typeof message === 'string') ? message : JSON.stringify(message));
      if (!messageObjectCopy) {
        return;
      }
      test.onMessageReceived(messageObjectCopy, this._getTargetBySessionId(messageObjectCopy.sessionId));
    }

    const messageObject = ((typeof message === 'string') ? JSON.parse(message) : message) as Message;
    if (!messageObject) {
      return;
    }

    // Send all messages to proxy connections.
    let suppressUnknownMessageErrors = false;
    for (const session of this._sessions.values()) {
      if (!session.proxyConnection) {
        continue;
      }

      if (!session.proxyConnection._onMessage) {
        InspectorBackend.reportProtocolError(
            'Protocol Error: the session has a proxyConnection with no _onMessage', messageObject);
        continue;
      }

      session.proxyConnection._onMessage(messageObject);
      suppressUnknownMessageErrors = true;
    }

    const sessionId = messageObject.sessionId || '';
    const session = this._sessions.get(sessionId);
    if (!session) {
      if (!suppressUnknownMessageErrors) {
        InspectorBackend.reportProtocolError('Protocol Error: the message with wrong session id', messageObject);
      }
      return;
    }

    // If this message is directly for the target controlled by the proxy connection, don't handle it.
    if (session.proxyConnection) {
      return;
    }

    if (session.target._needsNodeJSPatching) {
      NodeURL.patch(messageObject);
    }

    if (messageObject.id !== undefined) {  // just a response for some request
      const callback = session.callbacks.get(messageObject.id);
      session.callbacks.delete(messageObject.id);
      if (!callback) {
        if (!suppressUnknownMessageErrors) {
          InspectorBackend.reportProtocolError('Protocol Error: the message with wrong id', messageObject);
        }
        return;
      }

      callback.callback(messageObject.error || null, messageObject.result || null);
      --this._pendingResponsesCount;
      this._pendingLongPollingMessageIds.delete(messageObject.id);

      if (this._pendingScripts.length && !this._hasOutstandingNonLongPollingRequests()) {
        this._deprecatedRunAfterPendingDispatches();
      }
    } else {
      if (messageObject.method === undefined) {
        InspectorBackend.reportProtocolError('Protocol Error: the message without method', messageObject);
        return;
      }
      // This cast is justified as we just checked for the presence of messageObject.method.
      const eventMessage = messageObject as EventMessage;
      session.target.dispatch(eventMessage);
    }
  }

  _hasOutstandingNonLongPollingRequests(): boolean {
    return this._pendingResponsesCount - this._pendingLongPollingMessageIds.size > 0;
  }

  _deprecatedRunAfterPendingDispatches(script?: (() => void)): void {
    if (script) {
      this._pendingScripts.push(script);
    }

    // Execute all promises.
    setTimeout(() => {
      if (!this._hasOutstandingNonLongPollingRequests()) {
        this._executeAfterPendingDispatches();
      } else {
        this._deprecatedRunAfterPendingDispatches();
      }
    }, 0);
  }

  _executeAfterPendingDispatches(): void {
    if (!this._hasOutstandingNonLongPollingRequests()) {
      const scripts = this._pendingScripts;
      this._pendingScripts = [];
      for (let id = 0; id < scripts.length; ++id) {
        scripts[id]();
      }
    }
  }

  static dispatchConnectionError(callback: Callback, method: string): void {
    const error = {
      message: `Connection is closed, can\'t dispatch pending call to ${method}`,
      code: ConnectionClosedErrorCode,
      data: null,
    };
    setTimeout(() => callback(error, null), 0);
  }

  static dispatchUnregisterSessionError({callback, method}: CallbackWithDebugInfo): void {
    const error = {
      message: `Session is unregistering, can\'t dispatch pending call to ${method}`,
      code: ConnectionClosedErrorCode,
      data: null,
    };
    setTimeout(() => callback(error, null), 0);
  }
}

/**
  * Make sure that `Domain` in get/set is only ever instantiated with one protocol domain
  * name, because if `Domain` allows multiple domains, the type is unsound.
  */
interface AgentsMap extends Map<ProtocolDomainName, ProtocolProxyApi.ProtocolApi[ProtocolDomainName]> {
  get<Domain extends ProtocolDomainName>(key: Domain): ProtocolProxyApi.ProtocolApi[Domain]|undefined;
  set<Domain extends ProtocolDomainName>(key: Domain, value: ProtocolProxyApi.ProtocolApi[Domain]): this;
}

/**
  * Make sure that `Domain` in get/set is only ever instantiated with one protocol domain
  * name, because if `Domain` allows multiple domains, the type is unsound.
  */
interface DispatcherMap extends Map<ProtocolDomainName, ProtocolProxyApi.ProtocolDispatchers[ProtocolDomainName]> {
  get<Domain extends ProtocolDomainName>(key: Domain): DispatcherManager<Domain>|undefined;
  set<Domain extends ProtocolDomainName>(key: Domain, value: DispatcherManager<Domain>): this;
}

export class TargetBase {
  _needsNodeJSPatching: boolean;
  _sessionId: string;
  _router: SessionRouter|null;
  private agents: AgentsMap = new Map();
  private dispatchers: DispatcherMap = new Map();

  constructor(
      needsNodeJSPatching: boolean, parentTarget: TargetBase|null, sessionId: string, connection: Connection|null) {
    this._needsNodeJSPatching = needsNodeJSPatching;
    this._sessionId = sessionId;

    if ((!parentTarget && connection) || (!parentTarget && sessionId) || (connection && sessionId)) {
      throw new Error('Either connection or sessionId (but not both) must be supplied for a child target');
    }

    let router: SessionRouter;
    if (sessionId && parentTarget && parentTarget._router) {
      router = parentTarget._router;
    } else if (connection) {
      router = new SessionRouter(connection);
    } else {
      router = new SessionRouter(connectionFactory());
    }

    this._router = router;

    router.registerSession(this, this._sessionId);

    for (const [domain, agentPrototype] of inspectorBackend._agentPrototypes) {
      const agent = Object.create((agentPrototype as _AgentPrototype));
      agent._target = this;
      this.agents.set(domain, agent);
    }

    for (const [domain, eventParameterNames] of inspectorBackend.getEventParamterNames().entries()) {
      this.dispatchers.set(domain, new DispatcherManager(eventParameterNames));
    }
  }

  dispatch(eventMessage: EventMessage): void {
    const [domainName, method] = splitQualifiedName(eventMessage.method);
    const dispatcher = this.dispatchers.get(domainName as ProtocolDomainName);
    if (!dispatcher) {
      InspectorBackend.reportProtocolError(
          `Protocol Error: the message ${eventMessage.method} is for non-existing domain '${domainName}'`,
          eventMessage);
      return;
    }
    dispatcher.dispatch(method, eventMessage);
  }

  dispose(_reason: string): void {
    if (!this._router) {
      return;
    }
    this._router.unregisterSession(this._sessionId);
    this._router = null;
  }

  isDisposed(): boolean {
    return !this._router;
  }

  markAsNodeJSForTest(): void {
    this._needsNodeJSPatching = true;
  }

  router(): SessionRouter|null {
    return this._router;
  }

  // Agent accessors, keep alphabetically sorted.

  /**
   * Make sure that `Domain` is only ever instantiated with one protocol domain
   * name, because if `Domain` allows multiple domains, the type is unsound.
   */
  private getAgent<Domain extends ProtocolDomainName>(domain: Domain): ProtocolProxyApi.ProtocolApi[Domain] {
    const agent = this.agents.get<Domain>(domain);
    if (!agent) {
      throw new Error('Accessing undefined agent');
    }
    return agent;
  }

  accessibilityAgent(): ProtocolProxyApi.AccessibilityApi {
    return this.getAgent('Accessibility');
  }

  animationAgent(): ProtocolProxyApi.AnimationApi {
    return this.getAgent('Animation');
  }

  applicationCacheAgent(): ProtocolProxyApi.ApplicationCacheApi {
    return this.getAgent('ApplicationCache');
  }

  auditsAgent(): ProtocolProxyApi.AuditsApi {
    return this.getAgent('Audits');
  }

  browserAgent(): ProtocolProxyApi.BrowserApi {
    return this.getAgent('Browser');
  }

  backgroundServiceAgent(): ProtocolProxyApi.BackgroundServiceApi {
    return this.getAgent('BackgroundService');
  }

  cacheStorageAgent(): ProtocolProxyApi.CacheStorageApi {
    return this.getAgent('CacheStorage');
  }

  cssAgent(): ProtocolProxyApi.CSSApi {
    return this.getAgent('CSS');
  }

  databaseAgent(): ProtocolProxyApi.DatabaseApi {
    return this.getAgent('Database');
  }

  debuggerAgent(): ProtocolProxyApi.DebuggerApi {
    return this.getAgent('Debugger');
  }

  deviceOrientationAgent(): ProtocolProxyApi.DeviceOrientationApi {
    return this.getAgent('DeviceOrientation');
  }

  domAgent(): ProtocolProxyApi.DOMApi {
    return this.getAgent('DOM');
  }

  domdebuggerAgent(): ProtocolProxyApi.DOMDebuggerApi {
    return this.getAgent('DOMDebugger');
  }

  domsnapshotAgent(): ProtocolProxyApi.DOMSnapshotApi {
    return this.getAgent('DOMSnapshot');
  }

  domstorageAgent(): ProtocolProxyApi.DOMStorageApi {
    return this.getAgent('DOMStorage');
  }

  emulationAgent(): ProtocolProxyApi.EmulationApi {
    return this.getAgent('Emulation');
  }

  heapProfilerAgent(): ProtocolProxyApi.HeapProfilerApi {
    return this.getAgent('HeapProfiler');
  }

  indexedDBAgent(): ProtocolProxyApi.IndexedDBApi {
    return this.getAgent('IndexedDB');
  }

  inputAgent(): ProtocolProxyApi.InputApi {
    return this.getAgent('Input');
  }

  ioAgent(): ProtocolProxyApi.IOApi {
    return this.getAgent('IO');
  }

  inspectorAgent(): ProtocolProxyApi.InspectorApi {
    return this.getAgent('Inspector');
  }

  layerTreeAgent(): ProtocolProxyApi.LayerTreeApi {
    return this.getAgent('LayerTree');
  }

  logAgent(): ProtocolProxyApi.LogApi {
    return this.getAgent('Log');
  }

  mediaAgent(): ProtocolProxyApi.MediaApi {
    return this.getAgent('Media');
  }

  memoryAgent(): ProtocolProxyApi.MemoryApi {
    return this.getAgent('Memory');
  }

  networkAgent(): ProtocolProxyApi.NetworkApi {
    return this.getAgent('Network');
  }

  overlayAgent(): ProtocolProxyApi.OverlayApi {
    return this.getAgent('Overlay');
  }

  pageAgent(): ProtocolProxyApi.PageApi {
    return this.getAgent('Page');
  }

  profilerAgent(): ProtocolProxyApi.ProfilerApi {
    return this.getAgent('Profiler');
  }

  performanceAgent(): ProtocolProxyApi.PerformanceApi {
    return this.getAgent('Performance');
  }

  runtimeAgent(): ProtocolProxyApi.RuntimeApi {
    return this.getAgent('Runtime');
  }

  securityAgent(): ProtocolProxyApi.SecurityApi {
    return this.getAgent('Security');
  }

  serviceWorkerAgent(): ProtocolProxyApi.ServiceWorkerApi {
    return this.getAgent('ServiceWorker');
  }

  storageAgent(): ProtocolProxyApi.StorageApi {
    return this.getAgent('Storage');
  }

  targetAgent(): ProtocolProxyApi.TargetApi {
    return this.getAgent('Target');
  }

  tracingAgent(): ProtocolProxyApi.TracingApi {
    return this.getAgent('Tracing');
  }

  webAudioAgent(): ProtocolProxyApi.WebAudioApi {
    return this.getAgent('WebAudio');
  }

  webAuthnAgent(): ProtocolProxyApi.WebAuthnApi {
    return this.getAgent('WebAuthn');
  }
  lynxAgent(): ProtocolProxyApi.LynxApi {
    return this.getAgent('Lynx');
  }

  // Dispatcher registration and de-registration, keep alphabetically sorted.

  /**
   * Make sure that `Domain` is only ever instantiated with one protocol domain
   * name, because if `Domain` allows multiple domains, the type is unsound.
   */
  private registerDispatcher<Domain extends ProtocolDomainName>(
      domain: Domain, dispatcher: ProtocolProxyApi.ProtocolDispatchers[Domain]): void {
    const manager = this.dispatchers.get(domain);
    if (!manager) {
      return;
    }
    manager.addDomainDispatcher(dispatcher);
  }

  /**
   * Make sure that `Domain` is only ever instantiated with one protocol domain
   * name, because if `Domain` allows multiple domains, the type is unsound.
   */
  private unregisterDispatcher<Domain extends ProtocolDomainName>(
      domain: Domain, dispatcher: ProtocolProxyApi.ProtocolDispatchers[Domain]): void {
    const manager = this.dispatchers.get(domain);
    if (!manager) {
      return;
    }
    manager.removeDomainDispatcher(dispatcher);
  }

  registerAnimationDispatcher(dispatcher: ProtocolProxyApi.AnimationDispatcher): void {
    this.registerDispatcher('Animation', dispatcher);
  }

  registerApplicationCacheDispatcher(dispatcher: ProtocolProxyApi.ApplicationCacheDispatcher): void {
    this.registerDispatcher('ApplicationCache', dispatcher);
  }

  registerAuditsDispatcher(dispatcher: ProtocolProxyApi.AuditsDispatcher): void {
    this.registerDispatcher('Audits', dispatcher);
  }

  registerCSSDispatcher(dispatcher: ProtocolProxyApi.CSSDispatcher): void {
    this.registerDispatcher('CSS', dispatcher);
  }

  registerDatabaseDispatcher(dispatcher: ProtocolProxyApi.DatabaseDispatcher): void {
    this.registerDispatcher('Database', dispatcher);
  }

  registerBackgroundServiceDispatcher(dispatcher: ProtocolProxyApi.BackgroundServiceDispatcher): void {
    this.registerDispatcher('BackgroundService', dispatcher);
  }

  registerDebuggerDispatcher(dispatcher: ProtocolProxyApi.DebuggerDispatcher): void {
    this.registerDispatcher('Debugger', dispatcher);
  }

  unregisterDebuggerDispatcher(dispatcher: ProtocolProxyApi.DebuggerDispatcher): void {
    this.unregisterDispatcher('Debugger', dispatcher);
  }

  registerDOMDispatcher(dispatcher: ProtocolProxyApi.DOMDispatcher): void {
    this.registerDispatcher('DOM', dispatcher);
  }

  registerDOMStorageDispatcher(dispatcher: ProtocolProxyApi.DOMStorageDispatcher): void {
    this.registerDispatcher('DOMStorage', dispatcher);
  }

  registerHeapProfilerDispatcher(dispatcher: ProtocolProxyApi.HeapProfilerDispatcher): void {
    this.registerDispatcher('HeapProfiler', dispatcher);
  }

  registerInspectorDispatcher(dispatcher: ProtocolProxyApi.InspectorDispatcher): void {
    this.registerDispatcher('Inspector', dispatcher);
  }

  registerLayerTreeDispatcher(dispatcher: ProtocolProxyApi.LayerTreeDispatcher): void {
    this.registerDispatcher('LayerTree', dispatcher);
  }

  registerLogDispatcher(dispatcher: ProtocolProxyApi.LogDispatcher): void {
    this.registerDispatcher('Log', dispatcher);
  }

  registerMediaDispatcher(dispatcher: ProtocolProxyApi.MediaDispatcher): void {
    this.registerDispatcher('Media', dispatcher);
  }

  registerNetworkDispatcher(dispatcher: ProtocolProxyApi.NetworkDispatcher): void {
    this.registerDispatcher('Network', dispatcher);
  }

  registerOverlayDispatcher(dispatcher: ProtocolProxyApi.OverlayDispatcher): void {
    this.registerDispatcher('Overlay', dispatcher);
  }

  registerPageDispatcher(dispatcher: ProtocolProxyApi.PageDispatcher): void {
    this.registerDispatcher('Page', dispatcher);
  }

  registerProfilerDispatcher(dispatcher: ProtocolProxyApi.ProfilerDispatcher): void {
    this.registerDispatcher('Profiler', dispatcher);
  }

  registerRuntimeDispatcher(dispatcher: ProtocolProxyApi.RuntimeDispatcher): void {
    this.registerDispatcher('Runtime', dispatcher);
  }

  registerSecurityDispatcher(dispatcher: ProtocolProxyApi.SecurityDispatcher): void {
    this.registerDispatcher('Security', dispatcher);
  }

  registerServiceWorkerDispatcher(dispatcher: ProtocolProxyApi.ServiceWorkerDispatcher): void {
    this.registerDispatcher('ServiceWorker', dispatcher);
  }

  registerStorageDispatcher(dispatcher: ProtocolProxyApi.StorageDispatcher): void {
    this.registerDispatcher('Storage', dispatcher);
  }

  registerTargetDispatcher(dispatcher: ProtocolProxyApi.TargetDispatcher): void {
    this.registerDispatcher('Target', dispatcher);
  }

  registerTracingDispatcher(dispatcher: ProtocolProxyApi.TracingDispatcher): void {
    this.registerDispatcher('Tracing', dispatcher);
  }

  registerWebAudioDispatcher(dispatcher: ProtocolProxyApi.WebAudioDispatcher): void {
    this.registerDispatcher('WebAudio', dispatcher);
  }
}

/**
 * This is a class that serves as the prototype for a domains agents (every target
 * has it's own set of agents). The InspectorBackend keeps an instance of this class
 * per domain, and each TargetBase creates its agents (via Object.create) and installs
 * this instance as prototype.
 *
 * The reasons this is done is so that on the prototypes we can install the implementations
 * of the invoke_enable, etc. methods that the front-end uses.
 */
// TODO(crbug.com/1172300) Ignored during the jsdoc to ts migration
// eslint-disable-next-line @typescript-eslint/naming-convention
class _AgentPrototype {
  _replyArgs: {
    [x: string]: string[],
  };
  _domain: string;
  _target!: TargetBase;
  _debouncedMethods: string[];
  _cachedMessages: Record<string, [Message, Callback]>;
  _unresolvedMessages: Record<string, number>;
  _timestamps: WeakMap<Callback, number>;

  constructor(domain: string) {
    this._replyArgs = {};
    this._domain = domain;
    this._debouncedMethods = ['DOM.getBoxModel', 'DOM.getNodeForLocation', 'CSS.getComputedStyleForNode']
    this._cachedMessages = {};
    this._unresolvedMessages = {};
    this._timestamps = new WeakMap();
  }

  registerCommand(methodName: UnqualifiedName, parameters: CommandParameter[], replyArgs: string[]): void {
    const domainAndMethod = qualifyName(this._domain, methodName);

    function sendMessagePromise(this: _AgentPrototype, ...args: unknown[]): Promise<unknown> {
      return _AgentPrototype.prototype._sendMessageToBackendPromise.call(this, domainAndMethod, parameters, args);
    }

    // @ts-ignore Method code generation
    this[methodName] = sendMessagePromise;

    function invoke(
        this: _AgentPrototype, request: Object|undefined = {}): Promise<Protocol.ProtocolResponseWithError> {
      return this._invoke(domainAndMethod, request);
    }

    // @ts-ignore Method code generation
    this['invoke_' + methodName] = invoke;

    this._replyArgs[domainAndMethod] = replyArgs;
  }

  _prepareParameters(
      method: string, parameters: CommandParameter[], args: unknown[], errorCallback: (arg0: string) => void): Object
      |null {
    const params: {[x: string]: unknown} = {};
    let hasParams = false;

    for (const param of parameters) {
      const paramName = param.name;
      const typeName = param.type;
      const optionalFlag = param.optional;

      if (!args.length && !optionalFlag) {
        errorCallback(
            `Protocol Error: Invalid number of arguments for method '${method}' call. ` +
            `It must have the following arguments ${JSON.stringify(parameters)}'.`);
        return null;
      }

      const value = args.shift();
      if (optionalFlag && typeof value === 'undefined') {
        continue;
      }

      if (typeof value !== typeName) {
        errorCallback(
            `Protocol Error: Invalid type of argument '${paramName}' for method '${method}' call. ` +
            `It must be '${typeName}' but it is '${typeof value}'.`);
        return null;
      }

      params[paramName] = value;
      hasParams = true;
    }

    if (args.length) {
      errorCallback(`Protocol Error: Extra ${args.length} arguments in a call to method '${method}'.`);
      return null;
    }

    return hasParams ? params : null;
  }

  _sendMessageToBackendPromise(method: QualifiedName, parameters: CommandParameter[], args: unknown[]):
      Promise<unknown> {
    let errorMessage;
    function onError(message: string): void {
      console.error(message);
      errorMessage = message;
    }
    const params = this._prepareParameters(method, parameters, args, onError);
    if (errorMessage) {
      return Promise.resolve(null);
    }

    return new Promise(resolve => {
      // TODO(crbug.com/1172300) Ignored during the jsdoc to ts migration
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const callback: Callback = (error: MessageError|null, result: any|null): void => {
        if (error) {
          if (!test.suppressRequestErrors && error.code !== DevToolsStubErrorCode && error.code !== GenericError &&
              error.code !== ConnectionClosedErrorCode) {
            console.error('Request ' + method + ' failed. ' + JSON.stringify(error));
          }

          resolve(null);
          return;
        }

        const args = this._replyArgs[method];
        resolve(result && args.length ? result[args[0]] : undefined);
      };

      if (!this._target._router) {
        SessionRouter.dispatchConnectionError(callback, method);
      } else {
        console.log('sending msg (to backend)', this._target._sessionId, this._domain, method, params)
        this._target._router.sendMessage(this._target._sessionId, this._domain, method, params, callback);
      }
    });
  }

  _destructMessage(message:[Message, Callback]): [string, string, QualifiedName, MessageParams, Callback] {
    let [{sessionId, domain, method, params}, callback] = message;
    return [sessionId || '', domain!, method!, params as MessageParams, callback];
  }
  _invoke(method: QualifiedName, request: Object|null): Promise<Protocol.ProtocolResponseWithError> {
    let message: Message;
    // console.log('---dealing msg', method, request);
    return new Promise(resolve => {
      if (this._debouncedMethods.includes(method)) {
        message = {
          sessionId: this._target._sessionId,
          domain: this._domain,
          method,
          params: request
        };
      };
      const callback: Callback = (error: MessageError|undefined|null, result: Object|null): void => {
        if (error && !test.suppressRequestErrors && error.code !== DevToolsStubErrorCode &&
            error.code !== GenericError && error.code !== ConnectionClosedErrorCode) {
          console.warn('Request ' + method + ' failed. ' + JSON.stringify(error));
        }
        // After receiving the reply message, calculate CDPLatency and report statistics
        let delay = Date.now() - this._timestamps.get(callback)!;
        // Delay greater than 20 seconds is considered a timeout and not reported
        if (delay.toString() !== 'NaN' && delay < 20000) {
          Host.InspectorFrontendHost.sendWindowMessage({
            type: 'update_delay',
            content: delay.toString()
          });
          // Report statistics, CDP message full link delay, ignore screenshot messages
          if (method !== 'Page.screencastFrameAck') {
            let errorObject = error ? {error: error.message} : {};
            // @ts-ignore
            Host.InspectorFrontendHost.reportToStatistics('devtool_CDP_latency',
              {
                type: 'lynx',
                // @ts-ignore
                lynxVersion: window.info?.sdkVersion,
                // @ts-ignore
                did: window.info?.did,
                // @ts-ignore
                network: window.info?.network,
                // @ts-ignore
                osType: window.info?.osType,
                domain: this._domain,
                method,
                ...errorObject,
              },
              {
                CDPLatency: delay,
              });
          }
        }
        this._timestamps.delete(callback);

        // Message anti-shake logic
        if (this._debouncedMethods.includes(method)) {
          // console.group();
          // console.log('msg (invoke)', this._target._sessionId || 'undefined', this._domain, method, request)
          // console.log('resp', result);
          // console.log('latency (ms)', Date.now() - this._timestamps[callback.toString()]);
          // console.groupEnd();
          // delete this._timestamps[callback.toString()];
          delete this._unresolvedMessages[method];
          // console.group('msg resolved');
          // Send cached messages of the same type
          if (this._cachedMessages[method]) {
            // console.log('sending cached msg', method, this._cachedMessages[method][0].params);
            if (!this._target._router) {
              SessionRouter.dispatchConnectionError(callback, method);
            } else {
              this._target._router.sendMessage(...this._destructMessage(this._cachedMessages[method]));
              this._unresolvedMessages[method] = 1;
              delete this._cachedMessages[method];
              // console.log('cached msg deleted');
            }
          }
          // console.groupEnd();
        }

        const errorMessage = error?.message;
        resolve({...result, getError: (): string | undefined => errorMessage});
      };

      if (!this._target._router) {
        SessionRouter.dispatchConnectionError(callback, method);
      } else {
        this._timestamps.set(callback, Date.now());
        if (this._debouncedMethods.includes(method)) {
          // If not waiting for a reply, send the next message
          if (!this._unresolvedMessages[method]) {
            // console.group('no unresolved msg');
            // If there is no cache, send a new message
            if (!this._cachedMessages[method]) {
              // console.group('no cached msg');
              // console.log('sending new msg', method, message.params);
              this._unresolvedMessages[method] = 1;
              this._target._router.sendMessage(...this._destructMessage([message, callback]));
              // console.groupEnd();
            }
            // If there is a cache, send the cached message and cache the new message
            else {
              // console.group('cached msg detected');
              this._target._router.sendMessage(...this._destructMessage(this._cachedMessages[method]));
              this._cachedMessages[method] = [message, callback];
              // console.log('sending cached msg', method, this._cachedMessages[method][0].params);
              // console.log('caching new msg', method, message.params);
              // console.groupEnd();
            }
            // console.groupEnd();
          }
          // If waiting for a reply, cache this message
          else {
            // console.log('previous msg unresolved, caching new msg');
            this._cachedMessages[method] = [message, callback];
          }
        } else {
          this._target._router.sendMessage(this._target._sessionId, this._domain, method, request, callback);
        }
      }
    });
  }
}

/**
 * A `DispatcherManager` has a collection of dispatchers that implement one of the
 * `ProtocolProxyApi.{Foo}Dispatcher` interfaces. Each target uses one of these per
 * domain to manage the registered dispatchers. The class knows the parameter names
 * of the events via `eventArgs`, which is a map managed by the inspector back-end
 * so that there is only one map per domain that is shared among all DispatcherManagers.
 */
class DispatcherManager<Domain extends ProtocolDomainName> {
  private eventArgs: ReadonlyEventParameterNames;
  private dispatchers: ProtocolProxyApi.ProtocolDispatchers[Domain][] = [];

  constructor(eventArgs: ReadonlyEventParameterNames) {
    this.eventArgs = eventArgs;
  }

  addDomainDispatcher(dispatcher: ProtocolProxyApi.ProtocolDispatchers[Domain]): void {
    this.dispatchers.push(dispatcher);
  }

  removeDomainDispatcher(dispatcher: ProtocolProxyApi.ProtocolDispatchers[Domain]): void {
    const index = this.dispatchers.indexOf(dispatcher);
    if (index === -1) {
      return;
    }
    this.dispatchers.splice(index, 1);
  }

  dispatch(event: UnqualifiedName, messageObject: EventMessage): void {
    if (!this.dispatchers.length) {
      return;
    }

    let decompressedParams: MessageParams = {};
    // messageObject may be a compressed string, check the compress field to determine whether it needs to be decompressed
    if (messageObject.compress) {
      // @ts-ignore base64js module was imported in entrypoint_template.html
      const byteArray = base64js.toByteArray(messageObject.params!);
      // @ts-ignore Zlib module was imported in entrypoint_template.html
      const inflate = new Zlib.Inflate(byteArray);
      const decompressedByteArray = inflate.decompress();
      decompressedParams = JSON.parse(new TextDecoder().decode(decompressedByteArray));
    }
    if (!this.eventArgs.has(messageObject.method)) {
      InspectorBackend.reportProtocolWarning(
          `Protocol Warning: Attempted to dispatch an unspecified event '${messageObject.method}'`, messageObject);
      return;
    }

    const messageParams = messageObject.compress ? {...decompressedParams} : {...messageObject.params as MessageParams};
    for (let index = 0; index < this.dispatchers.length; ++index) {
      const dispatcher = this.dispatchers[index];

      if (event in dispatcher) {
        const f = dispatcher[event as string as keyof ProtocolProxyApi.ProtocolDispatchers[Domain]];
        // @ts-ignore Can't type check the dispatch.
        f.call(dispatcher, messageParams);
      }
    }
  }
}

export const inspectorBackend = new InspectorBackend();
