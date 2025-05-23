// Copyright 2021 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/*
 * Copyright (C) IBM Corp. 2009  All rights reserved.
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
 *     * Neither the name of IBM Corp. nor the names of its
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

/* eslint-disable rulesdir/no_underscored_properties */

import * as Common from '../../core/common/common.js';
import * as Host from '../../core/host/host.js';
import * as i18n from '../../core/i18n/i18n.js';
import * as Platform from '../../core/platform/platform.js';
import * as SDK from '../../core/sdk/sdk.js';
import * as ObjectUI from '../../ui/legacy/components/object_ui/object_ui.js';
import * as Components from '../../ui/legacy/components/utils/utils.js';
import * as UI from '../../ui/legacy/legacy.js';
import type * as Protocol from '../../generated/protocol.js';

import {UISourceCodeFrame} from './UISourceCodeFrame.js';

const UIStrings = {
  /**
  *@description A context menu item in the Watch Expressions Sidebar Pane of the Sources panel
  */
  addWatchExpression: 'Add watch expression',
  /**
  *@description Tooltip/screen reader label of a button in the Sources panel that refreshes all watch expressions.
  */
  refreshWatchExpressions: 'Refresh watch expressions',
  /**
  *@description Empty element text content in Watch Expressions Sidebar Pane of the Sources panel
  */
  noWatchExpressions: 'No watch expressions',
  /**
  *@description A context menu item in the Watch Expressions Sidebar Pane of the Sources panel
  */
  deleteAllWatchExpressions: 'Delete all watch expressions',
  /**
  *@description A context menu item in the Watch Expressions Sidebar Pane of the Sources panel
  */
  addPropertyPathToWatch: 'Add property path to watch',
  /**
  *@description A context menu item in the Watch Expressions Sidebar Pane of the Sources panel
  */
  deleteWatchExpression: 'Delete watch expression',
  /**
  *@description Value element text content in Watch Expressions Sidebar Pane of the Sources panel
  */
  notAvailable: '<not available>',
  /**
  *@description A context menu item in the Watch Expressions Sidebar Pane of the Sources panel and Network pane request.
  */
  copyValue: 'Copy value',
};
const str_ = i18n.i18n.registerUIStrings('panels/sources/WatchExpressionsSidebarPane.ts', UIStrings);
const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);
let watchExpressionsSidebarPaneInstance: WatchExpressionsSidebarPane;

export class WatchExpressionsSidebarPane extends UI.ThrottledWidget.ThrottledWidget implements
    UI.ActionRegistration.ActionDelegate, UI.Toolbar.ItemsProvider, UI.ContextMenu.Provider {
  _watchExpressions: WatchExpression[];
  _emptyElement!: HTMLElement;
  _watchExpressionsSetting: Common.Settings.Setting<string[]>;
  _addButton: UI.Toolbar.ToolbarButton;
  _refreshButton: UI.Toolbar.ToolbarButton;
  _treeOutline: ObjectUI.ObjectPropertiesSection.ObjectPropertiesSectionsTreeOutline;
  _expandController: ObjectUI.ObjectPropertiesSection.ObjectPropertiesSectionsTreeExpandController;
  _linkifier: Components.Linkifier.Linkifier;
  private constructor() {
    super(true);
    this.registerRequiredCSS('ui/legacy/components/object_ui/objectValue.css');
    this.registerRequiredCSS('panels/sources/watchExpressionsSidebarPane.css');

    // TODO(szuend): Replace with a Set once the web test
    // panels/sources/debugger-ui/watch-expressions-preserve-expansion.js is either converted
    // to an e2e test or no longer accesses this variable directly.
    this._watchExpressions = [];
    this._watchExpressionsSetting =
        Common.Settings.Settings.instance().createLocalSetting<string[]>('watchExpressions', []);

    this._addButton = new UI.Toolbar.ToolbarButton(i18nString(UIStrings.addWatchExpression), 'largeicon-add');
    this._addButton.addEventListener(UI.Toolbar.ToolbarButton.Events.Click, _event => {
      this._addButtonClicked();
    });
    this._refreshButton =
        new UI.Toolbar.ToolbarButton(i18nString(UIStrings.refreshWatchExpressions), 'largeicon-refresh');
    this._refreshButton.addEventListener(UI.Toolbar.ToolbarButton.Events.Click, this.update, this);

    this.contentElement.classList.add('watch-expressions');
    this.contentElement.addEventListener('contextmenu', this._contextMenu.bind(this), false);
    this._treeOutline = new ObjectUI.ObjectPropertiesSection.ObjectPropertiesSectionsTreeOutline();
    this._treeOutline.registerRequiredCSS('panels/sources/watchExpressionsSidebarPane.css');
    this._treeOutline.setShowSelectionOnKeyboardFocus(/* show */ true);
    this._expandController =
        new ObjectUI.ObjectPropertiesSection.ObjectPropertiesSectionsTreeExpandController(this._treeOutline);

    UI.Context.Context.instance().addFlavorChangeListener(SDK.RuntimeModel.ExecutionContext, this.update, this);
    UI.Context.Context.instance().addFlavorChangeListener(SDK.DebuggerModel.CallFrame, this.update, this);
    this._linkifier = new Components.Linkifier.Linkifier();
    this.update();
  }

  static instance(): WatchExpressionsSidebarPane {
    if (!watchExpressionsSidebarPaneInstance) {
      watchExpressionsSidebarPaneInstance = new WatchExpressionsSidebarPane();
    }
    return watchExpressionsSidebarPaneInstance;
  }

  toolbarItems(): UI.Toolbar.ToolbarItem[] {
    return [this._addButton, this._refreshButton];
  }

  focus(): void {
    if (this.hasFocus()) {
      return;
    }
    if (this._watchExpressions.length > 0) {
      this._treeOutline.forceSelect();
    }
  }

  hasExpressions(): boolean {
    return Boolean(this._watchExpressionsSetting.get().length);
  }

  _saveExpressions(): void {
    const toSave = [];
    for (let i = 0; i < this._watchExpressions.length; i++) {
      const expression = this._watchExpressions[i].expression();
      if (expression) {
        toSave.push(expression);
      }
    }

    this._watchExpressionsSetting.set(toSave);
  }

  async _addButtonClicked(): Promise<void> {
    await UI.ViewManager.ViewManager.instance().showView('sources.watch');
    this._emptyElement.classList.add('hidden');
    this._createWatchExpression(null).startEditing();
  }

  doUpdate(): Promise<void> {
    this._linkifier.reset();
    this.contentElement.removeChildren();
    this._treeOutline.removeChildren();
    this._watchExpressions = [];
    this._emptyElement = (this.contentElement.createChild('div', 'gray-info-message') as HTMLElement);
    this._emptyElement.textContent = i18nString(UIStrings.noWatchExpressions);
    this._emptyElement.tabIndex = -1;
    const watchExpressionStrings = this._watchExpressionsSetting.get();
    if (watchExpressionStrings.length) {
      this._emptyElement.classList.add('hidden');
    }
    for (let i = 0; i < watchExpressionStrings.length; ++i) {
      const expression = watchExpressionStrings[i];
      if (!expression) {
        continue;
      }

      this._createWatchExpression(expression);
    }
    return Promise.resolve();
  }

  _createWatchExpression(expression: string|null): WatchExpression {
    this.contentElement.appendChild(this._treeOutline.element);
    const watchExpression = new WatchExpression(expression, this._expandController, this._linkifier);
    watchExpression.addEventListener(WatchExpression.Events.ExpressionUpdated, this._watchExpressionUpdated, this);
    this._treeOutline.appendChild(watchExpression.treeElement());
    this._watchExpressions.push(watchExpression);
    return watchExpression;
  }

  _watchExpressionUpdated(event: Common.EventTarget.EventTargetEvent): void {
    const watchExpression = (event.data as WatchExpression);
    if (!watchExpression.expression()) {
      Platform.ArrayUtilities.removeElement(this._watchExpressions, watchExpression);
      this._treeOutline.removeChild(watchExpression.treeElement());
      this._emptyElement.classList.toggle('hidden', Boolean(this._watchExpressions.length));
      if (this._watchExpressions.length === 0) {
        this._treeOutline.element.remove();
      }
    }

    this._saveExpressions();
  }

  _contextMenu(event: MouseEvent): void {
    const contextMenu = new UI.ContextMenu.ContextMenu(event);
    this._populateContextMenu(contextMenu, event);
    contextMenu.show();
  }

  _populateContextMenu(contextMenu: UI.ContextMenu.ContextMenu, event: MouseEvent): void {
    let isEditing = false;
    for (const watchExpression of this._watchExpressions) {
      isEditing = isEditing || watchExpression.isEditing();
    }

    if (!isEditing) {
      contextMenu.debugSection().appendItem(
          i18nString(UIStrings.addWatchExpression), this._addButtonClicked.bind(this));
    }

    if (this._watchExpressions.length > 1) {
      contextMenu.debugSection().appendItem(
          i18nString(UIStrings.deleteAllWatchExpressions), this._deleteAllButtonClicked.bind(this));
    }

    const treeElement = this._treeOutline.treeElementFromEvent(event);
    if (!treeElement) {
      return;
    }
    const currentWatchExpression =
        this._watchExpressions.find(watchExpression => treeElement.hasAncestorOrSelf(watchExpression.treeElement()));
    if (currentWatchExpression) {
      currentWatchExpression._populateContextMenu(contextMenu, event);
    }
  }

  _deleteAllButtonClicked(): void {
    this._watchExpressions = [];
    this._saveExpressions();
    this.update();
  }

  async _focusAndAddExpressionToWatch(expression: string): Promise<void> {
    await UI.ViewManager.ViewManager.instance().showView('sources.watch');
    this._createWatchExpression(expression);
    this._saveExpressions();
    this.update();
  }

  handleAction(_context: UI.Context.Context, _actionId: string): boolean {
    const frame = UI.Context.Context.instance().flavor(UISourceCodeFrame);
    if (!frame) {
      return false;
    }
    const text = frame.textEditor.text(frame.textEditor.selection());
    this._focusAndAddExpressionToWatch(text);
    return true;
  }

  appendApplicableItems(event: Event, contextMenu: UI.ContextMenu.ContextMenu, target: Object): void {
    if (target instanceof ObjectUI.ObjectPropertiesSection.ObjectPropertyTreeElement && !target.property.synthetic) {
      contextMenu.debugSection().appendItem(
          i18nString(UIStrings.addPropertyPathToWatch), () => this._focusAndAddExpressionToWatch(target.path()));
    }

    const frame = UI.Context.Context.instance().flavor(UISourceCodeFrame);
    if (!frame || frame.textEditor.selection().isEmpty()) {
      return;
    }

    contextMenu.debugSection().appendAction('sources.add-to-watch');
  }
}

export class WatchExpression extends Common.ObjectWrapper.ObjectWrapper {
  _treeElement!: UI.TreeOutline.TreeElement;
  _nameElement!: Element;
  _valueElement!: Element;
  _expression: string|null;
  _expandController: ObjectUI.ObjectPropertiesSection.ObjectPropertiesSectionsTreeExpandController;
  _element: HTMLDivElement;
  _editing: boolean;
  _linkifier: Components.Linkifier.Linkifier;
  _textPrompt?: ObjectUI.ObjectPropertiesSection.ObjectPropertyPrompt;
  _result?: SDK.RemoteObject.RemoteObject|null;
  _preventClickTimeout?: number;
  constructor(
      expression: string|null,
      expandController: ObjectUI.ObjectPropertiesSection.ObjectPropertiesSectionsTreeExpandController,
      linkifier: Components.Linkifier.Linkifier) {
    super();

    this._expression = expression;
    this._expandController = expandController;
    this._element = document.createElement('div');
    this._element.classList.add('watch-expression');
    this._element.classList.add('monospace');
    this._editing = false;
    this._linkifier = linkifier;

    this._createWatchExpression();
    this.update();
  }

  treeElement(): UI.TreeOutline.TreeElement {
    return this._treeElement;
  }

  expression(): string|null {
    return this._expression;
  }

  update(): void {
    const currentExecutionContext = UI.Context.Context.instance().flavor(SDK.RuntimeModel.ExecutionContext);
    if (currentExecutionContext && this._expression) {
      currentExecutionContext
          .evaluate(
              {
                expression: this._expression,
                objectGroup: WatchExpression.watchObjectGroupId,
                includeCommandLineAPI: false,
                silent: true,
                returnByValue: false,
                generatePreview: false,
                allowUnsafeEvalBlockedByCSP: undefined,
                disableBreaks: undefined,
                replMode: undefined,
                throwOnSideEffect: undefined,
                timeout: undefined,
              },
              /* userGesture */ false,
              /* awaitPromise */ false)
          .then(result => {
            if ('object' in result) {
              this._createWatchExpression(result.object, result.exceptionDetails);
            } else {
              this._createWatchExpression();
            }
          });
    } else {
      this._createWatchExpression();
    }
  }

  startEditing(): void {
    this._editing = true;
    this._treeElement.setDisableSelectFocus(true);
    this._element.removeChildren();
    const newDiv = this._element.createChild('div');
    newDiv.textContent = this._nameElement.textContent;
    this._textPrompt = new ObjectUI.ObjectPropertiesSection.ObjectPropertyPrompt();
    this._textPrompt.renderAsBlock();
    const proxyElement =
        (this._textPrompt.attachAndStartEditing(newDiv, this._finishEditing.bind(this)) as HTMLElement);
    this._treeElement.listItemElement.classList.add('watch-expression-editing');
    this._treeElement.collapse();
    proxyElement.classList.add('watch-expression-text-prompt-proxy');
    proxyElement.addEventListener('keydown', this._promptKeyDown.bind(this), false);
    const selection = this._element.getComponentSelection();
    if (selection) {
      selection.selectAllChildren(newDiv);
    }
  }

  isEditing(): boolean {
    return Boolean(this._editing);
  }

  _finishEditing(event: Event, canceled?: boolean): void {
    if (event) {
      event.consume(canceled);
    }

    this._editing = false;
    this._treeElement.setDisableSelectFocus(false);
    this._treeElement.listItemElement.classList.remove('watch-expression-editing');
    if (this._textPrompt) {
      this._textPrompt.detach();
      const newExpression = canceled ? this._expression : this._textPrompt.text();
      this._textPrompt = undefined;
      this._element.removeChildren();
      this._updateExpression(newExpression);
    }
  }

  _dblClickOnWatchExpression(event: Event): void {
    event.consume();
    if (!this.isEditing()) {
      this.startEditing();
    }
  }

  _updateExpression(newExpression: string|null): void {
    if (this._expression) {
      this._expandController.stopWatchSectionsWithId(this._expression);
    }
    this._expression = newExpression;
    this.update();
    this.dispatchEventToListeners(WatchExpression.Events.ExpressionUpdated, this);
  }

  _deleteWatchExpression(event: Event): void {
    event.consume(true);
    this._updateExpression(null);
  }

  _createWatchExpression(result?: SDK.RemoteObject.RemoteObject, exceptionDetails?: Protocol.Runtime.ExceptionDetails):
      void {
    this._result = result || null;

    this._element.removeChildren();
    const oldTreeElement = this._treeElement;
    this._createWatchExpressionTreeElement(result, exceptionDetails);
    if (oldTreeElement && oldTreeElement.parent) {
      const root = oldTreeElement.parent;
      const index = root.indexOfChild(oldTreeElement);
      root.removeChild(oldTreeElement);
      root.insertChild(this._treeElement, index);
    }
    this._treeElement.select();
  }

  _createWatchExpressionHeader(
      expressionValue?: SDK.RemoteObject.RemoteObject, exceptionDetails?: Protocol.Runtime.ExceptionDetails): Element {
    const headerElement = this._element.createChild('div', 'watch-expression-header');
    const deleteButton = UI.Icon.Icon.create('smallicon-cross', 'watch-expression-delete-button');
    UI.Tooltip.Tooltip.install(deleteButton, i18nString(UIStrings.deleteWatchExpression));
    deleteButton.addEventListener('click', this._deleteWatchExpression.bind(this), false);

    const titleElement = headerElement.createChild('div', 'watch-expression-title tree-element-title');
    titleElement.appendChild(deleteButton);
    this._nameElement = ObjectUI.ObjectPropertiesSection.ObjectPropertiesSection.createNameElement(this._expression);
    if (Boolean(exceptionDetails) || !expressionValue) {
      this._valueElement = document.createElement('span');
      this._valueElement.classList.add('watch-expression-error');
      this._valueElement.classList.add('value');
      titleElement.classList.add('dimmed');
      this._valueElement.textContent = i18nString(UIStrings.notAvailable);
      if (exceptionDetails !== undefined && exceptionDetails.exception !== undefined &&
          exceptionDetails.exception.description !== undefined) {
        UI.Tooltip.Tooltip.install(this._valueElement, exceptionDetails.exception.description);
      }
    } else {
      const propertyValue =
          ObjectUI.ObjectPropertiesSection.ObjectPropertiesSection.createPropertyValueWithCustomSupport(
              expressionValue, Boolean(exceptionDetails), false /* showPreview */, titleElement, this._linkifier);
      this._valueElement = propertyValue.element;
    }
    const separatorElement = document.createElement('span');
    separatorElement.classList.add('watch-expressions-separator');
    separatorElement.textContent = ': ';
    titleElement.append(this._nameElement, separatorElement, this._valueElement);

    return headerElement;
  }

  _createWatchExpressionTreeElement(
      expressionValue?: SDK.RemoteObject.RemoteObject, exceptionDetails?: Protocol.Runtime.ExceptionDetails): void {
    const headerElement = this._createWatchExpressionHeader(expressionValue, exceptionDetails);

    if (!exceptionDetails && expressionValue && expressionValue.hasChildren && !expressionValue.customPreview()) {
      headerElement.classList.add('watch-expression-object-header');
      this._treeElement = new ObjectUI.ObjectPropertiesSection.RootElement(expressionValue, this._linkifier);
      this._expandController.watchSection(
          (this._expression as string), (this._treeElement as ObjectUI.ObjectPropertiesSection.RootElement));
      this._treeElement.toggleOnClick = false;
      this._treeElement.listItemElement.addEventListener('click', this._onSectionClick.bind(this), false);
      this._treeElement.listItemElement.addEventListener('dblclick', this._dblClickOnWatchExpression.bind(this));
    } else {
      headerElement.addEventListener('dblclick', this._dblClickOnWatchExpression.bind(this));
      this._treeElement = new UI.TreeOutline.TreeElement();
    }
    this._treeElement.title = this._element;
    this._treeElement.listItemElement.classList.add('watch-expression-tree-item');
    this._treeElement.listItemElement.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !this.isEditing()) {
        this.startEditing();
        event.consume(true);
      }
    });
  }

  _onSectionClick(event: Event): void {
    event.consume(true);
    const mouseEvent = (event as MouseEvent);
    if (mouseEvent.detail === 1) {
      this._preventClickTimeout = window.setTimeout(handleClick.bind(this), 333);
    } else if (this._preventClickTimeout !== undefined) {
      window.clearTimeout(this._preventClickTimeout);
      this._preventClickTimeout = undefined;
    }

    function handleClick(this: WatchExpression): void {
      if (!this._treeElement) {
        return;
      }

      if (this._treeElement.expanded) {
        this._treeElement.collapse();
      } else if (!this._editing) {
        this._treeElement.expand();
      }
    }
  }

  _promptKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || isEscKey(event)) {
      this._finishEditing(event, isEscKey(event));
    }
  }

  _populateContextMenu(contextMenu: UI.ContextMenu.ContextMenu, event: Event): void {
    if (!this.isEditing()) {
      contextMenu.editSection().appendItem(
          i18nString(UIStrings.deleteWatchExpression), this._updateExpression.bind(this, null));
    }

    if (!this.isEditing() && this._result && (this._result.type === 'number' || this._result.type === 'string')) {
      contextMenu.clipboardSection().appendItem(
          i18nString(UIStrings.copyValue), this._copyValueButtonClicked.bind(this));
    }

    const target = UI.UIUtils.deepElementFromEvent(event);
    if (target && this._valueElement.isSelfOrAncestor(target) && this._result) {
      contextMenu.appendApplicableItems(this._result);
    }
  }

  _copyValueButtonClicked(): void {
    Host.InspectorFrontendHost.InspectorFrontendHostInstance.copyText(this._valueElement.textContent);
  }

  private static readonly watchObjectGroupId = 'watch-group';
}

export namespace WatchExpression {
  // TODO(crbug.com/1167717): Make this a const enum again
  // eslint-disable-next-line rulesdir/const_enum
  export const Events = {
    ExpressionUpdated: Symbol('ExpressionUpdated'),
  };
}
