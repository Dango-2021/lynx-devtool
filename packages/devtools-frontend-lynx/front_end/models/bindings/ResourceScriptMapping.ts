/*
 * Copyright (C) 2012 Google Inc. All rights reserved.
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

import * as Common from '../../core/common/common.js';
import * as i18n from '../../core/i18n/i18n.js';
import * as SDK from '../../core/sdk/sdk.js';
import * as Workspace from '../workspace/workspace.js';
import type * as Protocol from '../../generated/protocol.js';

import type {Breakpoint} from './BreakpointManager.js';
import {BreakpointManager} from './BreakpointManager.js';  // eslint-disable-line no-unused-vars
import {ContentProviderBasedProject} from './ContentProviderBasedProject.js';
import type {DebuggerSourceMapping, DebuggerWorkspaceBinding} from './DebuggerWorkspaceBinding.js'; // eslint-disable-line no-unused-vars
import {NetworkProject} from './NetworkProject.js';
import {metadataForURL} from './ResourceUtils.js';

const UIStrings = {
  /**
  *@description Error text displayed in the console when editing a live script fails. LiveEdit is
  *the name of the feature for editing code that is already running.
  *@example {warning} PH1
  */
  liveEditFailed: '`LiveEdit` failed: {PH1}',
  /**
  *@description Error text displayed in the console when compiling a live-edited script fails. LiveEdit is
  *the name of the feature for editing code that is already running.
  *@example {connection lost} PH1
  */
  liveEditCompileFailed: '`LiveEdit` compile failed: {PH1}',
};
const str_ = i18n.i18n.registerUIStrings('models/bindings/ResourceScriptMapping.ts', UIStrings);
const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);

export class ResourceScriptMapping implements DebuggerSourceMapping {
  _debuggerModel: SDK.DebuggerModel.DebuggerModel;
  _workspace: Workspace.Workspace.WorkspaceImpl;
  _debuggerWorkspaceBinding: DebuggerWorkspaceBinding;
  _uiSourceCodeToScriptFile: Map<Workspace.UISourceCode.UISourceCode, ResourceScriptFile>;
  _projects: Map<string, ContentProviderBasedProject>;
  _acceptedScripts: Set<SDK.Script.Script>;
  _eventListeners: Common.EventTarget.EventDescriptor[];

  constructor(
      debuggerModel: SDK.DebuggerModel.DebuggerModel, workspace: Workspace.Workspace.WorkspaceImpl,
      debuggerWorkspaceBinding: DebuggerWorkspaceBinding) {
    this._debuggerModel = debuggerModel;
    this._workspace = workspace;
    this._debuggerWorkspaceBinding = debuggerWorkspaceBinding;
    this._uiSourceCodeToScriptFile = new Map();

    this._projects = new Map();

    this._acceptedScripts = new Set();
    const runtimeModel = debuggerModel.runtimeModel();
    this._eventListeners = [
      this._debuggerModel.addEventListener(
          SDK.DebuggerModel.Events.ParsedScriptSource,
          event => {
            this._parsedScriptSource(event);
          },
          this),
      this._debuggerModel.addEventListener(
          SDK.DebuggerModel.Events.GlobalObjectCleared, this._globalObjectCleared, this),
      runtimeModel.addEventListener(
          SDK.RuntimeModel.Events.ExecutionContextDestroyed, this._executionContextDestroyed, this),
      runtimeModel.addEventListener(
          SDK.RuntimeModel.Events.LynxViewDestroyed, this._lynxViewDestroyed, this),
    ];
  }

  _project(script: SDK.Script.Script): ContentProviderBasedProject {
    const prefix = script.isContentScript() ? 'js:extensions:' : 'js::';
    const projectId = prefix + this._debuggerModel.target().id() + ':' + script.frameId;
    let project = this._projects.get(projectId);
    if (!project) {
      const projectType = script.isContentScript() ? Workspace.Workspace.projectTypes.ContentScripts :
                                                     Workspace.Workspace.projectTypes.Network;
      project = new ContentProviderBasedProject(
          this._workspace, projectId, projectType, '' /* displayName */, false /* isServiceProject */);
      NetworkProject.setTargetForProject(project, this._debuggerModel.target());
      this._projects.set(projectId, project);
    }
    return project;
  }

  rawLocationToUILocation(rawLocation: SDK.DebuggerModel.Location): Workspace.UISourceCode.UILocation|null {
    const script = rawLocation.script();
    if (!script) {
      return null;
    }
    const project = this._project(script);
    const uiSourceCode = project.uiSourceCodeForURL(script.sourceURL);
    if (!uiSourceCode) {
      return null;
    }
    const scriptFile = this._uiSourceCodeToScriptFile.get(uiSourceCode);
    if (!scriptFile) {
      return null;
    }
    if ((scriptFile.hasDivergedFromVM() && !scriptFile.isMergingToVM()) || scriptFile.isDivergingFromVM()) {
      return null;
    }
    if (!scriptFile._hasScripts([script])) {
      return null;
    }
    const lineNumber = rawLocation.lineNumber - (script.isInlineScriptWithSourceURL() ? script.lineOffset : 0);
    let columnNumber = rawLocation.columnNumber || 0;
    if (script.isInlineScriptWithSourceURL() && !lineNumber && columnNumber) {
      columnNumber -= script.columnOffset;
    }
    return uiSourceCode.uiLocation(lineNumber, columnNumber);
  }

  uiLocationToRawLocations(uiSourceCode: Workspace.UISourceCode.UISourceCode, lineNumber: number, columnNumber: number):
      SDK.DebuggerModel.Location[] {
    const scriptFile = this._uiSourceCodeToScriptFile.get(uiSourceCode);
    if (!scriptFile || typeof scriptFile._script === 'undefined') {
      return [];
    }
    const script = scriptFile._script;
    if (script.isInlineScriptWithSourceURL()) {
      return [this._debuggerModel.createRawLocation(
          script, lineNumber + script.lineOffset, lineNumber ? columnNumber : columnNumber + script.columnOffset)];
    }
    return [this._debuggerModel.createRawLocation(script, lineNumber, columnNumber)];
  }

  _acceptsScript(script: SDK.Script.Script): boolean {
    if (!script.sourceURL || script.isLiveEdit() || (script.isInlineScript() && !script.hasSourceURL)) {
      return false;
    }
    // Filter out embedder injected content scripts.
    if (script.isContentScript() && !script.hasSourceURL) {
      const parsedURL = new Common.ParsedURL.ParsedURL(script.sourceURL);
      if (!parsedURL.isValid) {
        return false;
      }
    }
    return true;
  }

  async _parsedScriptSource(event: Common.EventTarget.EventTargetEvent): Promise<void> {
    const script = (event.data as SDK.Script.Script);
    if (!this._acceptsScript(script)) {
      return;
    }
    this._acceptedScripts.add(script);
    const originalContentProvider = script.originalContentProvider();

    const url = script.sourceURL;
    const project = this._project(script);

    // Remove previous UISourceCode, if any
    const oldUISourceCode = project.uiSourceCodeForURL(url);
    if (oldUISourceCode) {
      const scriptFile = this._uiSourceCodeToScriptFile.get(oldUISourceCode);
      if (scriptFile && typeof scriptFile._script !== 'undefined') {
        await this._removeScript(scriptFile._script);
      }
    }

    // Create UISourceCode.
    const uiSourceCode = project.createUISourceCode(url, originalContentProvider.contentType());
    NetworkProject.setInitialFrameAttribution(uiSourceCode, script.frameId);
    const metadata = metadataForURL(this._debuggerModel.target(), script.frameId, url);

    // Bind UISourceCode to scripts.
    const scriptFile = new ResourceScriptFile(this, uiSourceCode, [script]);
    this._uiSourceCodeToScriptFile.set(uiSourceCode, scriptFile);

    const mimeType = script.isWasm() ? 'application/wasm' : 'text/javascript';
    project.addUISourceCodeWithProvider(uiSourceCode, originalContentProvider, metadata, mimeType);
    await this._debuggerWorkspaceBinding.updateLocations(script);
  }

  scriptFile(uiSourceCode: Workspace.UISourceCode.UISourceCode): ResourceScriptFile|null {
    return this._uiSourceCodeToScriptFile.get(uiSourceCode) || null;
  }

  async _removeScript(script: SDK.Script.Script): Promise<void> {
    if (!this._acceptedScripts.has(script)) {
      return;
    }
    this._acceptedScripts.delete(script);
    const project = this._project(script);
    const uiSourceCode = (project.uiSourceCodeForURL(script.sourceURL) as Workspace.UISourceCode.UISourceCode);
    const scriptFile = this._uiSourceCodeToScriptFile.get(uiSourceCode);
    if (scriptFile) {
      scriptFile.dispose();
    }
    this._uiSourceCodeToScriptFile.delete(uiSourceCode);
    project.removeFile(script.sourceURL);
    await this._debuggerWorkspaceBinding.updateLocations(script);
  }

  _executionContextDestroyed(event: Common.EventTarget.EventTargetEvent): void {
    const executionContext = (event.data as SDK.RuntimeModel.ExecutionContext);
    const scripts = this._debuggerModel.scriptsForExecutionContext(executionContext);
    for (const script of scripts) {
      this._removeScript(script);
    }
  }

  _lynxViewDestroyed(event: Common.EventTarget.EventTargetEvent): void {
    const viewId = (event.data as number);
    const scripts = this._debuggerModel.scriptsForLynxView(viewId);
    for (const script of scripts) {
      this._removeScript(script);
    }
  }

  _globalObjectCleared(_event: Common.EventTarget.EventTargetEvent): void {
    const scripts = Array.from(this._acceptedScripts);
    for (const script of scripts) {
      this._removeScript(script);
    }
  }

  resetForTest(): void {
    const scripts = Array.from(this._acceptedScripts);
    for (const script of scripts) {
      this._removeScript(script);
    }
  }

  dispose(): void {
    Common.EventTarget.removeEventListeners(this._eventListeners);
    const scripts = Array.from(this._acceptedScripts);
    for (const script of scripts) {
      this._removeScript(script);
    }
    for (const project of this._projects.values()) {
      project.removeProject();
    }
    this._projects.clear();
  }
}

export class ResourceScriptFile extends Common.ObjectWrapper.ObjectWrapper {
  _resourceScriptMapping: ResourceScriptMapping;
  _uiSourceCode: Workspace.UISourceCode.UISourceCode;
  _script: SDK.Script.Script|undefined;
  _scriptSource?: string|null;
  _isDivergingFromVM?: boolean;
  _hasDivergedFromVM?: boolean;
  _isMergingToVM?: boolean;
  constructor(
      resourceScriptMapping: ResourceScriptMapping, uiSourceCode: Workspace.UISourceCode.UISourceCode,
      scripts: SDK.Script.Script[]) {
    super();
    console.assert(scripts.length > 0);

    this._resourceScriptMapping = resourceScriptMapping;
    this._uiSourceCode = uiSourceCode;

    if (this._uiSourceCode.contentType().isScript()) {
      this._script = scripts[scripts.length - 1];
    }

    this._uiSourceCode.addEventListener(
        Workspace.UISourceCode.Events.WorkingCopyChanged, this._workingCopyChanged, this);
    this._uiSourceCode.addEventListener(
        Workspace.UISourceCode.Events.WorkingCopyCommitted, this._workingCopyCommitted, this);
  }

  _hasScripts(scripts: SDK.Script.Script[]): boolean {
    return Boolean(this._script) && this._script === scripts[0];
  }

  _isDiverged(): boolean {
    if (this._uiSourceCode.isDirty()) {
      return true;
    }
    if (!this._script) {
      return false;
    }
    if (typeof this._scriptSource === 'undefined' || this._scriptSource === null) {
      return false;
    }
    const workingCopy = this._uiSourceCode.workingCopy();
    if (!workingCopy) {
      return false;
    }

    // Match ignoring sourceURL.
    if (!workingCopy.startsWith(this._scriptSource.trimRight())) {
      return true;
    }
    const suffix = this._uiSourceCode.workingCopy().substr(this._scriptSource.length);
    return Boolean(suffix.length) && !suffix.match(SDK.Script.sourceURLRegex);
  }

  _workingCopyChanged(_event: Common.EventTarget.EventTargetEvent): void {
    this._update();
  }

  _workingCopyCommitted(_event: Common.EventTarget.EventTargetEvent): void {
    if (this._uiSourceCode.project().canSetFileContent()) {
      return;
    }
    if (!this._script) {
      return;
    }
    const debuggerModel = this._resourceScriptMapping._debuggerModel;
    const breakpoints = BreakpointManager.instance()
                            .breakpointLocationsForUISourceCode(this._uiSourceCode)
                            .map(breakpointLocation => breakpointLocation.breakpoint);
    const source = this._uiSourceCode.workingCopy();
    debuggerModel.setScriptSource(this._script.scriptId, source, (error, exceptionDetails) => {
      this.scriptSourceWasSet(source, breakpoints, error, exceptionDetails);
    });
  }

  async scriptSourceWasSet(
      source: string, breakpoints: Breakpoint[], error: string|null,
      exceptionDetails?: Protocol.Runtime.ExceptionDetails): Promise<void> {
    if (!error && !exceptionDetails) {
      this._scriptSource = source;
    }
    await this._update();

    if (!error && !exceptionDetails) {
      // Live edit can cause breakpoints to be in the wrong position, or to be lost altogether.
      // If any breakpoints were in the pre-live edit script, they need to be re-added.
      await Promise.all(breakpoints.map(breakpoint => breakpoint.refreshInDebugger()));
      return;
    }
    if (!exceptionDetails) {
      Common.Console.Console.instance().addMessage(
          i18nString(UIStrings.liveEditFailed, {PH1: String(error)}), Common.Console.MessageLevel.Warning);
      return;
    }
    const messageText = i18nString(UIStrings.liveEditCompileFailed, {PH1: exceptionDetails.text});
    this._uiSourceCode.addLineMessage(
        Workspace.UISourceCode.Message.Level.Error, messageText, exceptionDetails.lineNumber,
        exceptionDetails.columnNumber);
  }

  async _update(): Promise<void> {
    if (this._isDiverged() && !this._hasDivergedFromVM) {
      await this._divergeFromVM();
    } else if (!this._isDiverged() && this._hasDivergedFromVM) {
      await this._mergeToVM();
    }
  }

  async _divergeFromVM(): Promise<void> {
    if (this._script) {
      this._isDivergingFromVM = true;
      await this._resourceScriptMapping._debuggerWorkspaceBinding.updateLocations(this._script);
      delete this._isDivergingFromVM;
      this._hasDivergedFromVM = true;
      this.dispatchEventToListeners(ResourceScriptFile.Events.DidDivergeFromVM, this._uiSourceCode);
    }
  }

  async _mergeToVM(): Promise<void> {
    if (this._script) {
      delete this._hasDivergedFromVM;
      this._isMergingToVM = true;
      await this._resourceScriptMapping._debuggerWorkspaceBinding.updateLocations(this._script);
      delete this._isMergingToVM;
      this.dispatchEventToListeners(ResourceScriptFile.Events.DidMergeToVM, this._uiSourceCode);
    }
  }

  hasDivergedFromVM(): boolean {
    return Boolean(this._hasDivergedFromVM);
  }

  isDivergingFromVM(): boolean {
    return Boolean(this._isDivergingFromVM);
  }

  isMergingToVM(): boolean {
    return Boolean(this._isMergingToVM);
  }

  checkMapping(): void {
    if (!this._script || typeof this._scriptSource !== 'undefined') {
      this._mappingCheckedForTest();
      return;
    }
    this._script.requestContent().then(deferredContent => {
      this._scriptSource = deferredContent.content;
      this._update().then(() => this._mappingCheckedForTest());
    });
  }

  _mappingCheckedForTest(): void {
  }

  dispose(): void {
    this._uiSourceCode.removeEventListener(
        Workspace.UISourceCode.Events.WorkingCopyChanged, this._workingCopyChanged, this);
    this._uiSourceCode.removeEventListener(
        Workspace.UISourceCode.Events.WorkingCopyCommitted, this._workingCopyCommitted, this);
  }

  addSourceMapURL(sourceMapURL: string): void {
    if (!this._script) {
      return;
    }
    this._script.debuggerModel.setSourceMapURL(this._script, sourceMapURL);
  }

  hasSourceMapURL(): boolean {
    return this._script !== undefined && Boolean(this._script.sourceMapURL);
  }

  get script(): SDK.Script.Script|null {
    return this._script || null;
  }

  get uiSourceCode(): Workspace.UISourceCode.UISourceCode {
    return this._uiSourceCode;
  }
}

export namespace ResourceScriptFile {
  // TODO(crbug.com/1167717): Make this a const enum again
  // eslint-disable-next-line rulesdir/const_enum
  export enum Events {
    DidMergeToVM = 'DidMergeToVM',
    DidDivergeFromVM = 'DidDivergeFromVM',
  }
}
