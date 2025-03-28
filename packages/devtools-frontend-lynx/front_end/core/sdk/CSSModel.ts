/*
 * Copyright (C) 2010 Google Inc. All rights reserved.
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

import * as TextUtils from '../../models/text_utils/text_utils.js';
import * as Common from '../common/common.js';
import * as Host from '../host/host.js';
import * as Platform from '../platform/platform.js';
import type * as ProtocolProxyApi from '../../generated/protocol-proxy-api.js';
import type * as Protocol from '../../generated/protocol.js';

import {CSSFontFace} from './CSSFontFace.js';
import {CSSMatchedStyles} from './CSSMatchedStyles.js';
import {CSSMedia} from './CSSMedia.js';
import {CSSStyleRule} from './CSSRule.js';
import {CSSStyleDeclaration, Type} from './CSSStyleDeclaration.js';
import {CSSStyleSheetHeader} from './CSSStyleSheetHeader.js';
import type {DOMNode} from './DOMModel.js';
import {DOMModel} from './DOMModel.js';  // eslint-disable-line no-unused-vars
import {Events as ResourceTreeModelEvents, ResourceTreeModel} from './ResourceTreeModel.js';
import type {Target} from './Target.js';
import {Capability} from './Target.js';
import {SDKModel} from './SDKModel.js';
import {SourceMapManager} from './SourceMapManager.js';
import { reportToStatistics } from '../host/InspectorFrontendHost.js';

export class CSSModel extends SDKModel {
  _isEnabled: boolean;
  _cachedMatchedCascadeNode: DOMNode|null;
  _cachedMatchedCascadePromise: Promise<CSSMatchedStyles|null>|null;
  _domModel: DOMModel;
  _sourceMapManager: SourceMapManager<CSSStyleSheetHeader>;
  _agent: ProtocolProxyApi.CSSApi;
  _styleLoader: ComputedStyleLoader;
  _resourceTreeModel: ResourceTreeModel|null;
  _styleSheetIdToHeader: Map<string, CSSStyleSheetHeader>;
  _styleSheetIdsForURL: Map<string, Map<string, Set<string>>>;
  _originalStyleSheetText: Map<CSSStyleSheetHeader, Promise<string|null>>;
  _isRuleUsageTrackingEnabled: boolean;
  _fontFaces: Map<string, CSSFontFace>;
  _cssPropertyTracker: CSSPropertyTracker|null;
  _isCSSPropertyTrackingEnabled: boolean;
  _isTrackingRequestPending: boolean;
  _trackedCSSProperties: Map<number, Protocol.CSS.CSSComputedStyleProperty[]>;
  _stylePollingThrottler: Common.Throttler.Throttler;

  constructor(target: Target) {
    super(target);
    this._isEnabled = false;
    this._cachedMatchedCascadeNode = null;
    this._cachedMatchedCascadePromise = null;
    this._domModel = (target.model(DOMModel) as DOMModel);
    this._sourceMapManager = new SourceMapManager(target);
    this._agent = target.cssAgent();
    this._styleLoader = new ComputedStyleLoader(this);
    this._resourceTreeModel = target.model(ResourceTreeModel);
    if (this._resourceTreeModel) {
      this._resourceTreeModel.addEventListener(
          ResourceTreeModelEvents.MainFrameNavigated, this._resetStyleSheets, this);
    }
    target.registerCSSDispatcher(new CSSDispatcher(this));
    if (!target.suspended()) {
      this._enable();
    }
    this._styleSheetIdToHeader = new Map();
    this._styleSheetIdsForURL = new Map();

    this._originalStyleSheetText = new Map();

    this._isRuleUsageTrackingEnabled = false;

    this._fontFaces = new Map();

    this._cssPropertyTracker = null;  // TODO: support multiple trackers when we refactor the backend
    this._isCSSPropertyTrackingEnabled = false;
    this._isTrackingRequestPending = false;
    this._trackedCSSProperties = new Map();
    this._stylePollingThrottler = new Common.Throttler.Throttler(StylePollingInterval);

    this._sourceMapManager.setEnabled(Common.Settings.Settings.instance().moduleSetting('cssSourceMapsEnabled').get());
    Common.Settings.Settings.instance()
        .moduleSetting('cssSourceMapsEnabled')
        .addChangeListener(event => this._sourceMapManager.setEnabled((event.data as boolean)));
  }

  headersForSourceURL(sourceURL: string): CSSStyleSheetHeader[] {
    const headers = [];
    for (const headerId of this.getStyleSheetIdsForURL(sourceURL)) {
      const header = this.styleSheetHeaderForId(headerId);
      if (header) {
        headers.push(header);
      }
    }
    return headers;
  }

  createRawLocationsByURL(sourceURL: string, lineNumber: number, columnNumber: number|undefined = 0): CSSLocation[] {
    const headers = this.headersForSourceURL(sourceURL);
    headers.sort(stylesheetComparator);
    const endIndex = Platform.ArrayUtilities.upperBound(
        headers, undefined, (_, header) => lineNumber - header.startLine || columnNumber - header.startColumn);
    if (!endIndex) {
      return [];
    }
    const locations = [];
    const last = headers[endIndex - 1];
    for (let index = endIndex - 1;
         index >= 0 && headers[index].startLine === last.startLine && headers[index].startColumn === last.startColumn;
         --index) {
      if (headers[index].containsLocation(lineNumber, columnNumber)) {
        locations.push(new CSSLocation(headers[index], lineNumber, columnNumber));
      }
    }

    return locations;
    function stylesheetComparator(a: CSSStyleSheetHeader, b: CSSStyleSheetHeader): number {
      return a.startLine - b.startLine || a.startColumn - b.startColumn || a.id.localeCompare(b.id);
    }
  }

  sourceMapManager(): SourceMapManager<CSSStyleSheetHeader> {
    return this._sourceMapManager;
  }

  static trimSourceURL(text: string): string {
    let sourceURLIndex = text.lastIndexOf('/*# sourceURL=');
    if (sourceURLIndex === -1) {
      sourceURLIndex = text.lastIndexOf('/*@ sourceURL=');
      if (sourceURLIndex === -1) {
        return text;
      }
    }
    const sourceURLLineIndex = text.lastIndexOf('\n', sourceURLIndex);
    if (sourceURLLineIndex === -1) {
      return text;
    }
    const sourceURLLine = text.substr(sourceURLLineIndex + 1).split('\n', 1)[0];
    const sourceURLRegex = /[\040\t]*\/\*[#@] sourceURL=[\040\t]*([^\s]*)[\040\t]*\*\/[\040\t]*$/;
    if (sourceURLLine.search(sourceURLRegex) === -1) {
      return text;
    }
    return text.substr(0, sourceURLLineIndex) + text.substr(sourceURLLineIndex + sourceURLLine.length + 1);
  }

  domModel(): DOMModel {
    return this._domModel;
  }

  async setStyleText(styleSheetId: string, range: TextUtils.TextRange.TextRange, text: string, majorChange: boolean):
      Promise<boolean> {
    try {
      await this._ensureOriginalStyleSheetText(styleSheetId);

      const {styles} = await this._agent.invoke_setStyleTexts(
          {edits: [{styleSheetId: styleSheetId, range: range.serializeToObject(), text}]});
      if (!styles || styles.length !== 1) {
        return false;
      }

      this._domModel.markUndoableState(!majorChange);
      const edit = new Edit(styleSheetId, range, text, styles[0]);
      this._fireStyleSheetChanged(styleSheetId, edit);
      return true;
    } catch (e) {
      return false;
    }
  }

  async setSelectorText(styleSheetId: string, range: TextUtils.TextRange.TextRange, text: string): Promise<boolean> {
    Host.userMetrics.actionTaken(Host.UserMetrics.Action.StyleRuleEdited);

    try {
      await this._ensureOriginalStyleSheetText(styleSheetId);
      const {selectorList} = await this._agent.invoke_setRuleSelector({styleSheetId, range, selector: text});

      if (!selectorList) {
        return false;
      }
      this._domModel.markUndoableState();
      const edit = new Edit(styleSheetId, range, text, selectorList);
      this._fireStyleSheetChanged(styleSheetId, edit);
      return true;
    } catch (e) {
      return false;
    }
  }

  async setKeyframeKey(styleSheetId: string, range: TextUtils.TextRange.TextRange, text: string): Promise<boolean> {
    Host.userMetrics.actionTaken(Host.UserMetrics.Action.StyleRuleEdited);

    try {
      await this._ensureOriginalStyleSheetText(styleSheetId);
      const {keyText} = await this._agent.invoke_setKeyframeKey({styleSheetId, range, keyText: text});

      if (!keyText) {
        return false;
      }
      this._domModel.markUndoableState();
      const edit = new Edit(styleSheetId, range, text, keyText);
      this._fireStyleSheetChanged(styleSheetId, edit);
      return true;
    } catch (e) {
      return false;
    }
  }

  startCoverage(): Promise<Protocol.ProtocolResponseWithError> {
    this._isRuleUsageTrackingEnabled = true;
    return this._agent.invoke_startRuleUsageTracking();
  }

  async takeCoverageDelta(): Promise<{
    timestamp: number,
    coverage: Array<Protocol.CSS.RuleUsage>,
  }> {
    const r = await this._agent.invoke_takeCoverageDelta();
    const timestamp = (r && r.timestamp) || 0;
    const coverage = (r && r.coverage) || [];
    return {timestamp, coverage};
  }

  setLocalFontsEnabled(enabled: boolean): Promise<Protocol.ProtocolResponseWithError> {
    return this._agent.invoke_setLocalFontsEnabled({
      enabled,
    });
  }

  async stopCoverage(): Promise<void> {
    this._isRuleUsageTrackingEnabled = false;
    await this._agent.invoke_stopRuleUsageTracking();
  }

  async mediaQueriesPromise(): Promise<CSSMedia[]> {
    const {medias} = await this._agent.invoke_getMediaQueries();
    return medias ? CSSMedia.parseMediaArrayPayload(this, medias) : [];
  }

  isEnabled(): boolean {
    return this._isEnabled;
  }

  async _enable(): Promise<void> {
    await this._agent.invoke_enable();
    this._isEnabled = true;
    if (this._isRuleUsageTrackingEnabled) {
      await this.startCoverage();
    }
    this.dispatchEventToListeners(Events.ModelWasEnabled);
  }

  async matchedStylesPromise(nodeId: Protocol.DOM.NodeId): Promise<CSSMatchedStyles|null> {
    // report event track for CSS.getMatchedStylesForNode
    const statisticsCommonParams = {
      type: 'getMatchedStylesForNode',
      pageType: 'lynx'
    };
    const timeout = setTimeout(() => {
      reportToStatistics("devtool_css_model", {
        ...statisticsCommonParams,
        eventType: 'not_responded_in_5s'
      });
    }, 5000);

    reportToStatistics('devtool_css_model', {
      ...statisticsCommonParams,
      eventType: 'sent'
    });

    const response = await this._agent.invoke_getMatchedStylesForNode({nodeId});

    clearTimeout(timeout);
    reportToStatistics('devtool_css_model', {
      ...statisticsCommonParams,
      eventType: 'responded'
    });

    if (response.getError()) {
      reportToStatistics('devtool_css_model', {
        ...statisticsCommonParams,
        eventType: 'error',
        message: response.getError()
      });
      return null;
    }

    const node = this._domModel.nodeForId(nodeId);
    if (!node) {
      reportToStatistics('devtool_css_model', {
        ...statisticsCommonParams,
        eventType: 'node_not_found'
      });
      return null;
    }

    reportToStatistics('devtool_css_model', {
      ...statisticsCommonParams,
      eventType: 'generate_styles'
    });

    return new CSSMatchedStyles(
        this, (node as DOMNode), response.inlineStyle || null, response.attributesStyle || null,
        response.matchedCSSRules || [], response.pseudoElements || [], response.inherited || [],
        response.cssKeyframesRules || []);
  }

  async classNamesPromise(styleSheetId: string): Promise<string[]> {
    const {classNames} = await this._agent.invoke_collectClassNames({styleSheetId});
    return classNames || [];
  }

  computedStylePromise(nodeId: Protocol.DOM.NodeId): Promise<Map<string, string>|null> {
    return this._styleLoader.computedStylePromise(nodeId);
  }

  async backgroundColorsPromise(nodeId: Protocol.DOM.NodeId): Promise<ContrastInfo|null> {
    const response = await this._agent.invoke_getBackgroundColors({nodeId});
    if (response.getError()) {
      return null;
    }

    return {
      backgroundColors: response.backgroundColors || null,
      computedFontSize: response.computedFontSize || '',
      computedFontWeight: response.computedFontWeight || '',
    };
  }

  async platformFontsPromise(nodeId: Protocol.DOM.NodeId): Promise<Protocol.CSS.PlatformFontUsage[]|null> {
    // method not implemented
    // const {fonts} = await this._agent.invoke_getPlatformFontsForNode({nodeId});
    // return fonts;
    return null;
  }

  allStyleSheets(): CSSStyleSheetHeader[] {
    const values = [...this._styleSheetIdToHeader.values()];
    function styleSheetComparator(a: CSSStyleSheetHeader, b: CSSStyleSheetHeader): number {
      if (a.sourceURL < b.sourceURL) {
        return -1;
      }
      if (a.sourceURL > b.sourceURL) {
        return 1;
      }
      return a.startLine - b.startLine || a.startColumn - b.startColumn;
    }
    values.sort(styleSheetComparator);

    return values;
  }

  async inlineStylesPromise(nodeId: Protocol.DOM.NodeId): Promise<InlineStyleResult|null> {
    const response = await this._agent.invoke_getInlineStylesForNode({nodeId});
    if (response.getError() || !response.inlineStyle || Object.keys(response.inlineStyle).length === 0) {
      return null;
    }
    const inlineStyle = new CSSStyleDeclaration(this, null, response.inlineStyle, Type.Inline);
    const attributesStyle = response.attributesStyle ?
        new CSSStyleDeclaration(this, null, response.attributesStyle, Type.Attributes) :
        null;
    return new InlineStyleResult(inlineStyle, attributesStyle);
  }

  forcePseudoState(node: DOMNode, pseudoClass: string, enable: boolean): boolean {
    const forcedPseudoClasses = node.marker<string[]>(PseudoStateMarker) || [];
    const hasPseudoClass = forcedPseudoClasses.includes(pseudoClass);
    if (enable) {
      if (hasPseudoClass) {
        return false;
      }
      forcedPseudoClasses.push(pseudoClass);
      node.setMarker(PseudoStateMarker, forcedPseudoClasses);
    } else {
      if (!hasPseudoClass) {
        return false;
      }
      Platform.ArrayUtilities.removeElement(forcedPseudoClasses, pseudoClass);
      if (forcedPseudoClasses.length) {
        node.setMarker(PseudoStateMarker, forcedPseudoClasses);
      } else {
        node.setMarker(PseudoStateMarker, null);
      }
    }

    if (node.id === undefined) {
      return false;
    }
    this._agent.invoke_forcePseudoState({nodeId: node.id, forcedPseudoClasses});
    this.dispatchEventToListeners(Events.PseudoStateForced, {node: node, pseudoClass: pseudoClass, enable: enable});
    return true;
  }

  pseudoState(node: DOMNode): string[]|null {
    return node.marker(PseudoStateMarker) || [];
  }

  async setMediaText(styleSheetId: string, range: TextUtils.TextRange.TextRange, newMediaText: string):
      Promise<boolean> {
    Host.userMetrics.actionTaken(Host.UserMetrics.Action.StyleRuleEdited);

    try {
      await this._ensureOriginalStyleSheetText(styleSheetId);
      const {media} = await this._agent.invoke_setMediaText({styleSheetId, range, text: newMediaText});

      if (!media) {
        return false;
      }
      this._domModel.markUndoableState();
      const edit = new Edit(styleSheetId, range, newMediaText, media);
      this._fireStyleSheetChanged(styleSheetId, edit);
      return true;
    } catch (e) {
      return false;
    }
  }

  async setContainerQueryText(
      styleSheetId: string, range: TextUtils.TextRange.TextRange, newContainerQueryText: string): Promise<boolean> {
    Host.userMetrics.actionTaken(Host.UserMetrics.Action.StyleRuleEdited);

    try {
      await this._ensureOriginalStyleSheetText(styleSheetId);
      const {containerQuery} =
          await this._agent.invoke_setContainerQueryText({styleSheetId, range, text: newContainerQueryText});

      if (!containerQuery) {
        return false;
      }
      this._domModel.markUndoableState();
      const edit = new Edit(styleSheetId, range, newContainerQueryText, containerQuery);
      this._fireStyleSheetChanged(styleSheetId, edit);
      return true;
    } catch (e) {
      return false;
    }
  }

  async addRule(styleSheetId: string, ruleText: string, ruleLocation: TextUtils.TextRange.TextRange):
      Promise<CSSStyleRule|null> {
    try {
      await this._ensureOriginalStyleSheetText(styleSheetId);
      const {rule} = await this._agent.invoke_addRule({styleSheetId, ruleText, location: ruleLocation});

      if (!rule) {
        return null;
      }
      this._domModel.markUndoableState();
      const edit = new Edit(styleSheetId, ruleLocation, ruleText, rule);
      this._fireStyleSheetChanged(styleSheetId, edit);
      return new CSSStyleRule(this, rule);
    } catch (e) {
      return null;
    }
  }

  async requestViaInspectorStylesheet(node: DOMNode): Promise<CSSStyleSheetHeader|null> {
    const frameId = node.frameId() ||
        (this._resourceTreeModel && this._resourceTreeModel.mainFrame ? this._resourceTreeModel.mainFrame.id : '');
    const headers = [...this._styleSheetIdToHeader.values()];
    const styleSheetHeader = headers.find(header => header.frameId === frameId && header.isViaInspector());
    if (styleSheetHeader) {
      return styleSheetHeader;
    }

    try {
      const {styleSheetId} = await this._agent.invoke_createStyleSheet({frameId});
      if (!styleSheetId) {
        return null;
      }
      return this._styleSheetIdToHeader.get(styleSheetId) || null;
    } catch (e) {
      return null;
    }
  }

  mediaQueryResultChanged(): void {
    this.dispatchEventToListeners(Events.MediaQueryResultChanged);
  }

  fontsUpdated(fontFace?: Protocol.CSS.FontFace|null): void {
    if (fontFace) {
      this._fontFaces.set(fontFace.src, new CSSFontFace(fontFace));
    }
    this.dispatchEventToListeners(Events.FontsUpdated);
  }

  fontFaces(): CSSFontFace[] {
    return [...this._fontFaces.values()];
  }

  styleSheetHeaderForId(id: string): CSSStyleSheetHeader|null {
    return this._styleSheetIdToHeader.get(id) || null;
  }

  styleSheetHeaders(): CSSStyleSheetHeader[] {
    return [...this._styleSheetIdToHeader.values()];
  }

  _fireStyleSheetChanged(styleSheetId: string, edit?: Edit): void {
    this.dispatchEventToListeners(Events.StyleSheetChanged, {styleSheetId: styleSheetId, edit: edit});
  }

  _ensureOriginalStyleSheetText(styleSheetId: string): Promise<string|null> {
    const header = this.styleSheetHeaderForId(styleSheetId);
    if (!header) {
      return Promise.resolve((null as string | null));
    }
    let promise = this._originalStyleSheetText.get(header);
    if (!promise) {
      promise = this.getStyleSheetText(header.id);
      this._originalStyleSheetText.set(header, promise);
      this._originalContentRequestedForTest(header);
    }
    return promise;
  }

  _originalContentRequestedForTest(_header: CSSStyleSheetHeader): void {
  }

  originalStyleSheetText(header: CSSStyleSheetHeader): Promise<string|null> {
    return this._ensureOriginalStyleSheetText(header.id);
  }

  getAllStyleSheetHeaders(): Iterable<CSSStyleSheetHeader> {
    return this._styleSheetIdToHeader.values();
  }

  _styleSheetAdded(header: Protocol.CSS.CSSStyleSheetHeader): void {
    // TODO: this assertion always fails.
    if (this._styleSheetIdToHeader.has(header.styleSheetId)) {
      return;
    }
    // console.assert(!this._styleSheetIdToHeader.get(header.styleSheetId));

    const styleSheetHeader = new CSSStyleSheetHeader(this, header);
    this._styleSheetIdToHeader.set(header.styleSheetId, styleSheetHeader);
    const url = styleSheetHeader.resourceURL();
    let frameIdToStyleSheetIds = this._styleSheetIdsForURL.get(url);
    if (!frameIdToStyleSheetIds) {
      frameIdToStyleSheetIds = new Map();
      this._styleSheetIdsForURL.set(url, frameIdToStyleSheetIds);
    }
    if (frameIdToStyleSheetIds) {
      let styleSheetIds = frameIdToStyleSheetIds.get(styleSheetHeader.frameId);
      if (!styleSheetIds) {
        styleSheetIds = new Set();
        frameIdToStyleSheetIds.set(styleSheetHeader.frameId, styleSheetIds);
      }
      styleSheetIds.add(styleSheetHeader.id);
    }
    this._sourceMapManager.attachSourceMap(styleSheetHeader, styleSheetHeader.sourceURL, styleSheetHeader.sourceMapURL);
    this.dispatchEventToListeners(Events.StyleSheetAdded, styleSheetHeader);
  }

  _styleSheetRemoved(id: string): void {
    const header = this._styleSheetIdToHeader.get(id);
    console.assert(Boolean(header));
    if (!header) {
      return;
    }
    this._styleSheetIdToHeader.delete(id);
    const url = header.resourceURL();
    const frameIdToStyleSheetIds = this._styleSheetIdsForURL.get(url);
    console.assert(
        Boolean(frameIdToStyleSheetIds), 'No frameId to styleSheetId map is available for given style sheet URL.');
    if (frameIdToStyleSheetIds) {
      const stylesheetIds = frameIdToStyleSheetIds.get(header.frameId);
      if (stylesheetIds) {
        stylesheetIds.delete(id);
        if (!stylesheetIds.size) {
          frameIdToStyleSheetIds.delete(header.frameId);
          if (!frameIdToStyleSheetIds.size) {
            this._styleSheetIdsForURL.delete(url);
          }
        }
      }
    }
    this._originalStyleSheetText.delete(header);
    this._sourceMapManager.detachSourceMap(header);
    this.dispatchEventToListeners(Events.StyleSheetRemoved, header);
  }

  getStyleSheetIdsForURL(url: string): string[] {
    const frameIdToStyleSheetIds = this._styleSheetIdsForURL.get(url);
    if (!frameIdToStyleSheetIds) {
      return [];
    }

    const result = [];
    for (const styleSheetIds of frameIdToStyleSheetIds.values()) {
      result.push(...styleSheetIds);
    }
    return result;
  }

  async setStyleSheetText(styleSheetId: string, newText: string, majorChange: boolean): Promise<string|null> {
    const header = (this._styleSheetIdToHeader.get(styleSheetId) as CSSStyleSheetHeader);
    console.assert(Boolean(header));
    newText = CSSModel.trimSourceURL(newText);
    if (header.hasSourceURL) {
      newText += '\n/*# sourceURL=' + header.sourceURL + ' */';
    }

    await this._ensureOriginalStyleSheetText(styleSheetId);
    const response = await this._agent.invoke_setStyleSheetText({styleSheetId: header.id, text: newText});
    const sourceMapURL = response.sourceMapURL;

    this._sourceMapManager.detachSourceMap(header);
    header.setSourceMapURL(sourceMapURL);
    this._sourceMapManager.attachSourceMap(header, header.sourceURL, header.sourceMapURL);
    if (sourceMapURL === null) {
      return 'Error in CSS.setStyleSheetText';
    }
    this._domModel.markUndoableState(!majorChange);
    this._fireStyleSheetChanged(styleSheetId);
    return null;
  }

  async getStyleSheetText(styleSheetId: string): Promise<string|null> {
    try {
      const {text} = await this._agent.invoke_getStyleSheetText({styleSheetId});
      return text && CSSModel.trimSourceURL(text);
    } catch (e) {
      return null;
    }
  }

  _resetStyleSheets(): void {
    const headers = [...this._styleSheetIdToHeader.values()];
    this._styleSheetIdsForURL.clear();
    this._styleSheetIdToHeader.clear();
    for (const header of headers) {
      this._sourceMapManager.detachSourceMap(header);
      this.dispatchEventToListeners(Events.StyleSheetRemoved, header);
    }
  }

  _resetFontFaces(): void {
    this._fontFaces.clear();
  }

  async suspendModel(): Promise<void> {
    this._isEnabled = false;
    await this._agent.invoke_disable();
    this._resetStyleSheets();
    this._resetFontFaces();
  }

  async resumeModel(): Promise<void> {
    return this._enable();
  }

  setEffectivePropertyValueForNode(nodeId: Protocol.DOM.NodeId, propertyName: string, value: string): void {
    this._agent.invoke_setEffectivePropertyValueForNode({nodeId, propertyName, value});
  }

  cachedMatchedCascadeForNode(node: DOMNode): Promise<CSSMatchedStyles|null> {
    if (this._cachedMatchedCascadeNode !== node) {
      this.discardCachedMatchedCascade();
    }
    this._cachedMatchedCascadeNode = node;
    if (!this._cachedMatchedCascadePromise) {
      if (node.id) {
        this._cachedMatchedCascadePromise = this.matchedStylesPromise(node.id);
      } else {
        return Promise.resolve(null);
      }
    }
    return this._cachedMatchedCascadePromise;
  }

  discardCachedMatchedCascade(): void {
    this._cachedMatchedCascadeNode = null;
    this._cachedMatchedCascadePromise = null;
  }

  createCSSPropertyTracker(propertiesToTrack: Protocol.CSS.CSSComputedStyleProperty[]): CSSPropertyTracker {
    const gridStyleTracker = new CSSPropertyTracker(this, propertiesToTrack);
    return gridStyleTracker;
  }

  enableCSSPropertyTracker(cssPropertyTracker: CSSPropertyTracker): void {
    const propertiesToTrack = cssPropertyTracker.getTrackedProperties();
    if (propertiesToTrack.length === 0) {
      return;
    }
    // method not implemented
    // this._agent.invoke_trackComputedStyleUpdates({propertiesToTrack});
    this._isCSSPropertyTrackingEnabled = true;
    this._cssPropertyTracker = cssPropertyTracker;
    this._pollComputedStyleUpdates();
  }

  // Since we only support one tracker at a time, this call effectively disables
  // style tracking.
  disableCSSPropertyTracker(): void {
    this._isCSSPropertyTrackingEnabled = false;
    this._cssPropertyTracker = null;
    // Sending an empty list to the backend signals the close of style tracking
    // method not implemented
    // this._agent.invoke_trackComputedStyleUpdates({propertiesToTrack: []});
  }

  async _pollComputedStyleUpdates(): Promise<void> {
    if (this._isTrackingRequestPending) {
      return;
    }

    if (this._isCSSPropertyTrackingEnabled) {
      this._isTrackingRequestPending = true;
      // method not implemented
      // const result = await this._agent.invoke_takeComputedStyleUpdates();
      this._isTrackingRequestPending = false;

      // method not implemented
      // if (result.getError() || !result.nodeIds || !this._isCSSPropertyTrackingEnabled) {
      //   return;
      // }
      return;

      // if (this._cssPropertyTracker) {
      //   this._cssPropertyTracker.dispatchEventToListeners(CSSPropertyTrackerEvents.TrackedCSSPropertiesUpdated, {
      //     domNodes: result.nodeIds.map(nodeId => this._domModel.nodeForId(nodeId)),
      //   });
      // }
    }

    if (this._isCSSPropertyTrackingEnabled) {
      this._stylePollingThrottler.schedule(this._pollComputedStyleUpdates.bind(this));
    }
  }

  dispose(): void {
    this.disableCSSPropertyTracker();
    super.dispose();
    this._sourceMapManager.dispose();
  }
}

// TODO(crbug.com/1167717): Make this a const enum again
// eslint-disable-next-line rulesdir/const_enum
export enum Events {
  FontsUpdated = 'FontsUpdated',
  MediaQueryResultChanged = 'MediaQueryResultChanged',
  ModelWasEnabled = 'ModelWasEnabled',
  PseudoStateForced = 'PseudoStateForced',
  StyleSheetAdded = 'StyleSheetAdded',
  StyleSheetChanged = 'StyleSheetChanged',
  StyleSheetRemoved = 'StyleSheetRemoved',
}


const PseudoStateMarker = 'pseudo-state-marker';

export class Edit {
  styleSheetId: string;
  oldRange: TextUtils.TextRange.TextRange;
  newRange: TextUtils.TextRange.TextRange;
  newText: string;
  payload: Object|null;
  constructor(styleSheetId: string, oldRange: TextUtils.TextRange.TextRange, newText: string, payload: Object|null) {
    this.styleSheetId = styleSheetId;
    this.oldRange = oldRange;
    this.newRange = TextUtils.TextRange.TextRange.fromEdit(oldRange, newText);
    this.newText = newText;
    this.payload = payload;
  }
}

export class CSSLocation {
  _cssModel: CSSModel;
  styleSheetId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
  constructor(header: CSSStyleSheetHeader, lineNumber: number, columnNumber?: number) {
    this._cssModel = header.cssModel();
    this.styleSheetId = header.id;
    this.url = header.resourceURL();
    this.lineNumber = lineNumber;
    this.columnNumber = columnNumber || 0;
  }

  cssModel(): CSSModel {
    return this._cssModel;
  }

  header(): CSSStyleSheetHeader|null {
    return this._cssModel.styleSheetHeaderForId(this.styleSheetId);
  }
}

class CSSDispatcher implements ProtocolProxyApi.CSSDispatcher {
  _cssModel: CSSModel;
  constructor(cssModel: CSSModel) {
    this._cssModel = cssModel;
  }

  mediaQueryResultChanged(): void {
    this._cssModel.mediaQueryResultChanged();
  }

  fontsUpdated({font}: Protocol.CSS.FontsUpdatedEvent): void {
    this._cssModel.fontsUpdated(font);
  }

  styleSheetChanged({styleSheetId}: Protocol.CSS.StyleSheetChangedEvent): void {
    this._cssModel._fireStyleSheetChanged(styleSheetId);
  }

  styleSheetAdded({header}: Protocol.CSS.StyleSheetAddedEvent): void {
    this._cssModel._styleSheetAdded(header);
  }

  styleSheetRemoved({styleSheetId}: Protocol.CSS.StyleSheetRemovedEvent): void {
    this._cssModel._styleSheetRemoved(styleSheetId);
  }
}

class ComputedStyleLoader {
  _cssModel: CSSModel;
  constructor(cssModel: CSSModel) {
    this._cssModel = cssModel;
  }

  computedStylePromise(nodeId: Protocol.DOM.NodeId): Promise<Map<string, string>|null> {
    const promise = this._cssModel._agent.invoke_getComputedStyleForNode({nodeId}).then(({computedStyle}) => {
      if (!computedStyle || !computedStyle.length) {
        return null;
      }
      const result = new Map<string, string>();
      for (const property of computedStyle) {
        result.set(property.name, property.value);
      }
      return result;
    });
    return promise;
  }
}

export class InlineStyleResult {
  inlineStyle: CSSStyleDeclaration|null;
  attributesStyle: CSSStyleDeclaration|null;
  constructor(inlineStyle: CSSStyleDeclaration|null, attributesStyle: CSSStyleDeclaration|null) {
    this.inlineStyle = inlineStyle;
    this.attributesStyle = attributesStyle;
  }
}

export class CSSPropertyTracker extends Common.ObjectWrapper.ObjectWrapper {
  _cssModel: CSSModel;
  _properties: Protocol.CSS.CSSComputedStyleProperty[];
  constructor(cssModel: CSSModel, propertiesToTrack: Protocol.CSS.CSSComputedStyleProperty[]) {
    super();
    this._cssModel = cssModel;
    this._properties = propertiesToTrack;
  }

  start(): void {
    this._cssModel.enableCSSPropertyTracker(this);
  }

  stop(): void {
    this._cssModel.disableCSSPropertyTracker();
  }

  getTrackedProperties(): Protocol.CSS.CSSComputedStyleProperty[] {
    return this._properties;
  }
}

const StylePollingInterval = 1000;  // throttling interval for style polling, in milliseconds

// TODO(crbug.com/1167717): Make this a const enum again
// eslint-disable-next-line rulesdir/const_enum
export enum CSSPropertyTrackerEvents {
  TrackedCSSPropertiesUpdated = 'TrackedCSSPropertiesUpdated',
}


SDKModel.register(CSSModel, {capabilities: Capability.DOM, autostart: true});
export interface ContrastInfo {
  backgroundColors: string[]|null;
  computedFontSize: string;
  computedFontWeight: string;
}
