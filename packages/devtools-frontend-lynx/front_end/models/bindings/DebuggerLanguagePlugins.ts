// Copyright 2020 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/* eslint-disable rulesdir/no_underscored_properties */

import * as Common from '../../core/common/common.js';
import * as i18n from '../../core/i18n/i18n.js';
import * as SDK from '../../core/sdk/sdk.js';
import * as Protocol from '../../generated/protocol.js';
import * as Workspace from '../workspace/workspace.js';

import {ContentProviderBasedProject} from './ContentProviderBasedProject.js';

import type {DebuggerWorkspaceBinding} from './DebuggerWorkspaceBinding.js'; // eslint-disable-line no-unused-vars
import {NetworkProject} from './NetworkProject.js';

const UIStrings = {
  /**
  *@description Error message that is displayed in the Console when language plugins report errors
  *@example {File not found} PH1
  */
  errorInDebuggerLanguagePlugin: 'Error in debugger language plugin: {PH1}',
  /**
  *@description Status message that is shown in the Console when debugging information is being
  *loaded. The 2nd and 3rd placeholders are URLs.
  *@example {C/C++ DevTools Support (DWARF)} PH1
  *@example {http://web.dev/file.wasm} PH2
  *@example {http://web.dev/file.wasm.debug.wasm} PH3
  */
  loadingDebugSymbolsForVia: '[{PH1}] Loading debug symbols for {PH2} (via {PH3})...',
  /**
  *@description Status message that is shown in the Console when debugging information is being loaded
  *@example {C/C++ DevTools Support (DWARF)} PH1
  *@example {http://web.dev/file.wasm} PH2
  */
  loadingDebugSymbolsFor: '[{PH1}] Loading debug symbols for {PH2}...',
  /**
  *@description Warning message that is displayed in the Console when debugging information was loaded, but no source files were found
  *@example {C/C++ DevTools Support (DWARF)} PH1
  *@example {http://web.dev/file.wasm} PH2
  */
  loadedDebugSymbolsForButDidnt: '[{PH1}] Loaded debug symbols for {PH2}, but didn\'t find any source files',
  /**
  *@description Status message that is shown in the Console when debugging information is successfully loaded
  *@example {C/C++ DevTools Support (DWARF)} PH1
  *@example {http://web.dev/file.wasm} PH2
  *@example {42} PH3
  */
  loadedDebugSymbolsForFound: '[{PH1}] Loaded debug symbols for {PH2}, found {PH3} source file(s)',
  /**
  *@description Error message that is displayed in the Console when debugging information cannot be loaded
  *@example {C/C++ DevTools Support (DWARF)} PH1
  *@example {http://web.dev/file.wasm} PH2
  *@example {File not found} PH3
  */
  failedToLoadDebugSymbolsFor: '[{PH1}] Failed to load debug symbols for {PH2} ({PH3})',
  /**
  *@description Error message that is displayed in UI debugging information cannot be found for a call frame
  *@example {main} PH1
  */
  failedToLoadDebugSymbolsForFunction: 'Missing debug symbols for function "{PH1}"',
  /**
  *@description Error message that is displayed in UI when a file needed for debugging information for a call frame is missing
  *@example {src/myapp.debug.wasm.dwp} PH1
  */
  symbolFileNotFound: 'Symbol file "{PH1}" not found',
};
const str_ = i18n.i18n.registerUIStrings('models/bindings/DebuggerLanguagePlugins.ts', UIStrings);
const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);

class SourceType {
  typeInfo: TypeInfo;
  members: SourceType[];
  // TODO(crbug.com/1172300) Ignored during the jsdoc to ts migration)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typeMap: Map<any, SourceType>;

  // TODO(crbug.com/1172300) Ignored during the jsdoc to ts migration)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(typeInfo: TypeInfo, members: SourceType[], typeMap: Map<any, SourceType>) {
    this.typeInfo = typeInfo;
    this.members = members;
    this.typeMap = typeMap;
  }

  /**
   * Create a type graph
   */
  static create(typeInfos: TypeInfo[]): SourceType|null {
    if (typeInfos.length === 0) {
      return null;
    }

    // TODO(crbug.com/1172300) Ignored during the jsdoc to ts migration)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const typeMap = new Map<any, SourceType>();
    for (const typeInfo of typeInfos) {
      typeMap.set(typeInfo.typeId, new SourceType(typeInfo, [], typeMap));
    }

    for (const sourceType of typeMap.values()) {
      sourceType.members = sourceType.typeInfo.members.map(({typeId}) => {
        const memberType = typeMap.get(typeId);
        if (!memberType) {
          throw new Error(`Incomplete type information for type ${typeInfos[0].typeNames[0] || '<anonymous>'}`);
        }
        return memberType;
      });
    }

    return typeMap.get(typeInfos[0].typeId) || null;
  }
}

/**
 * Generates the raw module ID for a script, which is used
 * to uniquely identify the debugging data for a script on
 * the responsible language plugin.
 *
 * @param script the unique raw module ID for the script.
 */
function rawModuleIdForScript(script: SDK.Script.Script): string {
  return `${script.sourceURL}@${script.hash}`;
}

function getRawLocation(callFrame: SDK.DebuggerModel.CallFrame): RawLocation {
  const {script} = callFrame;
  return {
    rawModuleId: rawModuleIdForScript(script),
    codeOffset: callFrame.location().columnNumber - (script.codeOffset() || 0),
    inlineFrameIndex: callFrame.inlineFrameIndex,
  };
}

async function resolveRemoteObject(
    // TODO(crbug.com/1172300) Ignored during the jsdoc to ts migration)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    callFrame: SDK.DebuggerModel.CallFrame, object: SDK.RemoteObject.RemoteObject): Promise<any> {
  if (typeof object.value !== 'undefined') {
    return object.value;
  }

  const response = await callFrame.debuggerModel.target().runtimeAgent().invoke_callFunctionOn(
      {functionDeclaration: 'function() { return this; }', objectId: object.objectId, returnByValue: true});
  const {result} = response;
  if (!result) {
    return undefined;
  }
  return result.value;
}

export class ValueNode extends SDK.RemoteObject.RemoteObjectImpl {
  inspectableAddress?: number;
  callFrame: SDK.DebuggerModel.CallFrame;

  constructor(
      callFrame: SDK.DebuggerModel.CallFrame, objectId: string|undefined, type: string, subtype: string|undefined,
      // TODO(crbug.com/1172300) Ignored during the jsdoc to ts migration)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      value: any, inspectableAddress?: number, unserializableValue?: string, description?: string,
      preview?: Protocol.Runtime.ObjectPreview, customPreview?: Protocol.Runtime.CustomPreview, className?: string) {
    super(
        callFrame.debuggerModel.runtimeModel(), objectId, type, subtype, value, unserializableValue, description,
        preview, customPreview, className);

    this.inspectableAddress = inspectableAddress;
    this.callFrame = callFrame;
  }
}

// Debugger language plugins present source-language values as trees with mixed dynamic and static structural
// information. The static structure is defined by the variable's static type in the source language. Formatters are
// able to present source-language values in an arbitrary user-friendly way, which contributes the dynamic structural
// information. The classes StaticallyTypedValue and FormatedValueNode respectively implement the static and dynamic
// parts in the RemoteObject tree that defines the presentation of the source-language value in the debugger UI.
//
// struct S {
//   int i;
//   struct A {
//     int j;
//   } a[3];
// } s
//
// The RemoteObject tree representing the C struct above could look like the graph below with a formatter for the type
// struct A[3], interleaving static and dynamic representations:
//
// StaticallyTypedValueNode   -->  s: struct S
//                                 \
//                                 |\
// StaticallyTypedValueNode   -->  | i: int
//                                 \
//                                  \
// StaticallyTypedValueNode   -->    a: struct A[3]
//                                   \
//                                   |\
// FormattedValueNode         -->    | 0: struct A
//                                   | \
//                                   |  \
// StaticallyTypedValueNode   -->    |   j: int
//                                   .
//                                   .
//                                   .

/** Create a new value tree from an expression.
 */
async function getValueTreeForExpression(
    callFrame: SDK.DebuggerModel.CallFrame, plugin: DebuggerLanguagePlugin, expression: string,
    evalOptions: SDK.RuntimeModel.EvaluationOptions): Promise<SDK.RemoteObject.RemoteObject> {
  const location = getRawLocation(callFrame);

  let typeInfo;
  try {
    typeInfo = await plugin.getTypeInfo(expression, location);
  } catch (e) {
    FormattingError.throwLocal(callFrame, e.message);
  }
  // If there's no type information we cannot represent this expression.
  if (!typeInfo) {
    return new SDK.RemoteObject.LocalJSONObject(undefined);
  }
  const {base, typeInfos} = typeInfo;
  const sourceType = SourceType.create(typeInfos);
  if (!sourceType) {
    return new SDK.RemoteObject.LocalJSONObject(undefined);
  }
  if (sourceType.typeInfo.hasValue && !sourceType.typeInfo.canExpand && base) {
    // Need to run the formatter for the expression result.
    return formatSourceValue(callFrame, plugin, sourceType, base, [], evalOptions);
  }

  // Create a new value tree with static information for the root.
  const address = await StaticallyTypedValueNode.getInspectableAddress(callFrame, plugin, base, [], evalOptions);
  return new StaticallyTypedValueNode(callFrame, plugin, sourceType, base, [], evalOptions, address);
}

/** Run the formatter for the value defined by the pair of base and fieldChain.
 */
async function formatSourceValue(
    callFrame: SDK.DebuggerModel.CallFrame, plugin: DebuggerLanguagePlugin, sourceType: SourceType, base: EvalBase,
    field: FieldInfo[], evalOptions: SDK.RuntimeModel.EvaluationOptions): Promise<FormattedValueNode> {
  const location = getRawLocation(callFrame);

  let evalCode: {
    js: string,
  }|({
    js: string,
  } | null) = await plugin.getFormatter({base, field}, location);
  if (!evalCode) {
    evalCode = {js: ''};
  }
  const response = await callFrame.debuggerModel.target().debuggerAgent().invoke_evaluateOnCallFrame({
    callFrameId: callFrame.id,
    expression: evalCode.js,
    objectGroup: evalOptions.objectGroup,
    includeCommandLineAPI: evalOptions.includeCommandLineAPI,
    silent: evalOptions.silent,
    returnByValue: evalOptions.returnByValue,
    generatePreview: evalOptions.generatePreview,
    throwOnSideEffect: evalOptions.throwOnSideEffect,
    timeout: evalOptions.timeout,
  });
  const error = response.getError();
  if (error) {
    throw new Error(error);
  }

  const {result, exceptionDetails} = response;
  if (exceptionDetails) {
    throw new FormattingError(callFrame.debuggerModel.runtimeModel().createRemoteObject(result), exceptionDetails);
  }
  // Wrap the formatted result into a FormattedValueNode.
  const object = new FormattedValueNode(callFrame, sourceType, plugin, result, null, evalOptions, undefined);
  // Check whether the formatter returned a plain object or and object alongisde a formatter tag.
  const unpackedResultObject = await unpackResultObject(object);
  const node = unpackedResultObject || object;

  if (typeof node.value === 'undefined' && node.type !== 'undefined') {
    node.description = sourceType.typeInfo.typeNames[0];
  }

  return node;

  async function unpackResultObject(object: FormattedValueNode): Promise<FormattedValueNode|null> {
    const {tag, value, inspectableAddress, description} =
        await object.findProperties('tag', 'value', 'inspectableAddress', 'description');
    if (!tag || !value) {
      return null;
    }
    const {className, symbol} = await tag.findProperties('className', 'symbol');
    if (!className || !symbol) {
      return null;
    }
    const resolvedClassName = className.value;
    if (typeof resolvedClassName !== 'string' || typeof symbol.objectId === 'undefined') {
      return null;
    }

    const descriptionText = description?.value;
    if (typeof descriptionText === 'string') {
      value.description = descriptionText;
    }

    value.formatterTag = {symbol: symbol.objectId, className: resolvedClassName};
    value.inspectableAddress = inspectableAddress ? inspectableAddress.value : undefined;
    return value;
  }
}

// Formatters produce proper JavaScript objects, which are mirrored as RemoteObjects. To implement interleaving of
// formatted and statically typed values, formatters may insert markers in the JavaScript objects. The markers contain
// the static type information (`EvalBase`)to create a new StaticallyTypedValueNode tree root. Markers are identified by
// their className and the presence of a special Symbol property. Both the class name and the symbol are defined by the
// `formatterTag` property.
//
// A FormattedValueNode is a RemoteObject whose properties can be either FormattedValueNodes or
// StaticallyTypedValueNodes. The class hooks into the creation of RemoteObjects for properties to check whether a
// property is a marker.
class FormattedValueNode extends ValueNode {
  _plugin: DebuggerLanguagePlugin;
  _sourceType: SourceType;
  formatterTag: {
    className: string,
    symbol: string,
  }|null;
  _evalOptions: SDK.RuntimeModel.EvaluationOptions;
  constructor(
      callFrame: SDK.DebuggerModel.CallFrame, sourceType: SourceType, plugin: DebuggerLanguagePlugin,
      object: Protocol.Runtime.RemoteObject, formatterTag: {
        className: string,
        symbol: string,
      }|null,
      evalOptions: SDK.RuntimeModel.EvaluationOptions, inspectableAddress: number|undefined) {
    super(
        callFrame, object.objectId, object.type, object.subtype, object.value, inspectableAddress,
        object.unserializableValue, object.description, object.preview, object.customPreview, object.className);

    this._plugin = plugin;
    this._sourceType = sourceType;

    // The tag describes how to identify a marker by its className and its identifier symbol's object id.
    this.formatterTag = formatterTag;

    this._evalOptions = evalOptions;
  }

  async findProperties(...properties: string[]): Promise<{
    [x: string]: FormattedValueNode | undefined,
  }> {
    const result: {
      [x: string]: FormattedValueNode|undefined,
    } = {};
    for (const prop of (await this.getOwnProperties(false)).properties || []) {
      if (properties.indexOf(prop.name) >= 0) {
        if (prop.value) {
          result[prop.name] = (prop.value as FormattedValueNode | undefined);
        }
      }
    }
    return result;
  }

  /**
   * Hook into RemoteObject creation for properties to check whether a property is a marker.
   */
  async _createRemoteObject(newObject: Protocol.Runtime.RemoteObject):
      Promise<FormattedValueNode|StaticallyTypedValueNode> {
    // Check if the property RemoteObject is a marker
    const base = await this._getEvalBaseFromObject(newObject);
    if (!base) {
      return new FormattedValueNode(
          this.callFrame, this._sourceType, this._plugin, newObject, this.formatterTag, this._evalOptions, undefined);
    }

    // Property is a marker, check if it's just static type information or if we need to run formatters for the value.
    const newSourceType = this._sourceType.typeMap.get(base.rootType.typeId);
    if (!newSourceType) {
      throw new Error('Unknown typeId in eval base');
    }
    // The marker refers to a value that needs to be formatted, so run the formatter.
    if (base.rootType.hasValue && !base.rootType.canExpand && base) {
      return formatSourceValue(this.callFrame, this._plugin, newSourceType, base, [], this._evalOptions);
    }

    // The marker is just static information, so start a new subtree with a static type info root.
    const address =
        await StaticallyTypedValueNode.getInspectableAddress(this.callFrame, this._plugin, base, [], this._evalOptions);
    return new StaticallyTypedValueNode(
        this.callFrame, this._plugin, newSourceType, base, [], this._evalOptions, address);
  }

  /**
   * Check whether an object is a marker and if so return the EvalBase it contains.
   */
  async _getEvalBaseFromObject(object: Protocol.Runtime.RemoteObject): Promise<EvalBase|null> {
    const {objectId} = object;
    if (!object || !this.formatterTag) {
      return null;
    }

    // A marker is definitively identified by the symbol property. To avoid checking the properties of all objects,
    // check the className first for an early exit.
    const {className, symbol} = this.formatterTag;
    if (className !== object.className) {
      return null;
    }

    const response = await this.debuggerModel().target().runtimeAgent().invoke_callFunctionOn(
        {functionDeclaration: 'function(sym) { return this[sym]; }', objectId, arguments: [{objectId: symbol}]});
    const {result} = response;
    if (!result || result.type === 'undefined') {
      return null;
    }

    // The object is a marker, so pull the static type information from its symbol property. The symbol property is not
    // a formatted value per se, but we wrap it as one to be able to call `findProperties`.
    const baseObject = new FormattedValueNode(
        this.callFrame, this._sourceType, this._plugin, result, null, this._evalOptions, undefined);
    const {payload, rootType} = await baseObject.findProperties('payload', 'rootType');
    if (typeof payload === 'undefined' || typeof rootType === 'undefined') {
      return null;
    }
    const value = await resolveRemoteObject(this.callFrame, payload);
    const {typeId} = await rootType.findProperties('typeId');
    if (typeof value === 'undefined' || typeof typeId === 'undefined') {
      return null;
    }

    const newSourceType = this._sourceType.typeMap.get(typeId.value);
    if (!newSourceType) {
      return null;
    }

    return {payload: value, rootType: newSourceType.typeInfo};
  }
}

class FormattingError extends Error {
  exception: SDK.RemoteObject.RemoteObject;
  exceptionDetails: Protocol.Runtime.ExceptionDetails;
  constructor(exception: SDK.RemoteObject.RemoteObject, exceptionDetails: Protocol.Runtime.ExceptionDetails) {
    const {description} = exceptionDetails.exception || {};
    super(description || exceptionDetails.text);
    this.exception = exception;
    this.exceptionDetails = exceptionDetails;
  }

  static throwLocal(callFrame: SDK.DebuggerModel.CallFrame, message: string): void {
    const exception: Protocol.Runtime.RemoteObject = {
      type: Protocol.Runtime.RemoteObjectType.Object,
      subtype: Protocol.Runtime.RemoteObjectSubtype.Error,
      description: message,
    };
    const exceptionDetails: Protocol.Runtime
        .ExceptionDetails = {text: 'Uncaught', exceptionId: -1, columnNumber: 0, lineNumber: 0, exception};
    const errorObject = callFrame.debuggerModel.runtimeModel().createRemoteObject(exception);
    throw new FormattingError(errorObject, exceptionDetails);
  }
}

// This class implements a `RemoteObject` for source language value whose immediate properties are defined purely by
// static type information. Static type information is expressed by an `EvalBase` together with a `fieldChain`. The
// latter is necessary to express navigating through type members. We don't know how to make sense of an `EvalBase`'s
// payload here, which is why member navigation is relayed to the formatter via the `fieldChain`.
class StaticallyTypedValueNode extends ValueNode {
  _variableType: string;
  _plugin: DebuggerLanguagePlugin;
  _sourceType: SourceType;
  _base: EvalBase|null;
  _fieldChain: FieldInfo[];
  _hasChildren: boolean;
  _evalOptions: SDK.RuntimeModel.EvaluationOptions;

  constructor(
      callFrame: SDK.DebuggerModel.CallFrame, plugin: DebuggerLanguagePlugin, sourceType: SourceType,
      base: EvalBase|null, fieldChain: FieldInfo[], evalOptions: SDK.RuntimeModel.EvaluationOptions,
      inspectableAddress: number|undefined) {
    const typeName = sourceType.typeInfo.typeNames[0] || '<anonymous>';
    const variableType = 'object';
    super(
        callFrame,
        /* objectId=*/ undefined,
        /* type=*/ variableType,
        /* subtype=*/ undefined, /* value=*/ null, inspectableAddress, /* unserializableValue=*/ undefined,
        /* description=*/ typeName, /* preview=*/ undefined, /* customPreview=*/ undefined, /* className=*/ typeName);
    this._variableType = variableType;
    this._plugin = plugin;
    this._sourceType = sourceType;
    this._base = base;
    this._fieldChain = fieldChain;
    this._hasChildren = true;
    this._evalOptions = evalOptions;
  }

  get type(): string {
    return this._variableType;
  }

  async _expandMember(sourceType: SourceType, fieldInfo: FieldInfo): Promise<SDK.RemoteObject.RemoteObject> {
    const fieldChain = this._fieldChain.concat(fieldInfo);
    if (sourceType.typeInfo.hasValue && !sourceType.typeInfo.canExpand && this._base) {
      return formatSourceValue(this.callFrame, this._plugin, sourceType, this._base, fieldChain, this._evalOptions);
    }

    const address = this.inspectableAddress !== undefined ? this.inspectableAddress + fieldInfo.offset : undefined;
    return new StaticallyTypedValueNode(
        this.callFrame, this._plugin, sourceType, this._base, fieldChain, this._evalOptions, address);
  }

  static async getInspectableAddress(
      callFrame: SDK.DebuggerModel.CallFrame, plugin: DebuggerLanguagePlugin, base: EvalBase|null, field: FieldInfo[],
      evalOptions: SDK.RuntimeModel.EvaluationOptions): Promise<number|undefined> {
    if (!base) {
      return undefined;
    }

    const addressCode = await plugin.getInspectableAddress({base, field});
    if (!addressCode.js) {
      return undefined;
    }
    const response = await callFrame.debuggerModel.target().debuggerAgent().invoke_evaluateOnCallFrame({
      callFrameId: callFrame.id,
      expression: addressCode.js,
      objectGroup: evalOptions.objectGroup,
      includeCommandLineAPI: evalOptions.includeCommandLineAPI,
      silent: evalOptions.silent,
      returnByValue: true,
      generatePreview: evalOptions.generatePreview,
      throwOnSideEffect: evalOptions.throwOnSideEffect,
      timeout: evalOptions.timeout,
    });

    const error = response.getError();
    if (error) {
      throw new Error(error);
    }

    const {result, exceptionDetails} = response;
    if (exceptionDetails) {
      throw new FormattingError(callFrame.debuggerModel.runtimeModel().createRemoteObject(result), exceptionDetails);
    }

    const address = result.value;
    if (!Number.isSafeInteger(address) || address < 0) {
      console.error(`Inspectable address is not a positive, safe integer: ${address}`);
      return undefined;
    }

    return address;
  }

  async doGetProperties(_ownProperties: boolean, accessorPropertiesOnly: boolean, _generatePreview: boolean):
      Promise<SDK.RemoteObject.GetPropertiesResult> {
    const {typeInfo} = this._sourceType;
    if (accessorPropertiesOnly || !typeInfo.canExpand) {
      return {properties: [], internalProperties: []} as SDK.RemoteObject.GetPropertiesResult;
    }

    if (typeInfo.members.length > 0) {
      // This value doesn't have a formatter, but we can eagerly expand arrays in the frontend if the size is known.
      if (typeInfo.arraySize > 0) {
        const {typeId} = this._sourceType.typeInfo.members[0];
        const properties: SDK.RemoteObject.RemoteObjectProperty[] = [];
        const elementTypeInfo = this._sourceType.members[0];
        for (let i = 0; i < typeInfo.arraySize; ++i) {
          const name = `${i}`;
          const elementField = {name, typeId, offset: elementTypeInfo.typeInfo.size * i};
          properties.push(new SDK.RemoteObject.RemoteObjectProperty(
              name, await this._expandMember(elementTypeInfo, elementField), /* enumerable=*/ false,
              /* writable=*/ false,
              /* isOwn=*/ true,
              /* wasThrown=*/ false));
        }
        return {properties, internalProperties: []} as SDK.RemoteObject.GetPropertiesResult;
      }

      // The node is expanded, just make remote objects for its members
      const members = Promise.all(this._sourceType.members.map(async (memberTypeInfo, idx) => {
        const fieldInfo = this._sourceType.typeInfo.members[idx];
        const propertyObject = await this._expandMember(memberTypeInfo, fieldInfo);
        const name = fieldInfo.name || '';
        return new SDK.RemoteObject.RemoteObjectProperty(
            name, propertyObject, /* enumerable=*/ false, /* writable=*/ false, /* isOwn=*/ true,
            /* wasThrown=*/ false);
      }));
      return {properties: await members, internalProperties: []} as SDK.RemoteObject.GetPropertiesResult;
    }

    return {properties: [], internalProperties: []} as SDK.RemoteObject.GetPropertiesResult;
  }
}

class NamespaceObject extends SDK.RemoteObject.LocalJSONObject {
  // TODO(crbug.com/1172300) Ignored during the jsdoc to ts migration)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(value: any) {
    super(value);
  }

  get description(): string {
    return this.type;
  }

  get type(): string {
    return 'namespace';
  }
}

class SourceScopeRemoteObject extends SDK.RemoteObject.RemoteObjectImpl {
  variables: Variable[];
  _callFrame: SDK.DebuggerModel.CallFrame;
  _plugin: DebuggerLanguagePlugin;
  _location: RawLocation;

  constructor(callFrame: SDK.DebuggerModel.CallFrame, plugin: DebuggerLanguagePlugin, location: RawLocation) {
    super(callFrame.debuggerModel.runtimeModel(), undefined, 'object', undefined, null);
    this.variables = [];
    this._callFrame = callFrame;
    this._plugin = plugin;
    this._location = location;
  }

  async doGetProperties(ownProperties: boolean, accessorPropertiesOnly: boolean, _generatePreview: boolean):
      Promise<SDK.RemoteObject.GetPropertiesResult> {
    if (accessorPropertiesOnly) {
      return {properties: [], internalProperties: []} as SDK.RemoteObject.GetPropertiesResult;
    }

    const properties = [];
    const namespaces: {
      [x: string]: SDK.RemoteObject.RemoteObject,
    } = {};

    function makeProperty(name: string, obj: SDK.RemoteObject.RemoteObject): SDK.RemoteObject.RemoteObjectProperty {
      return new SDK.RemoteObject.RemoteObjectProperty(
          name, obj,
          /* enumerable=*/ false, /* writable=*/ false, /* isOwn=*/ true, /* wasThrown=*/ false);
    }

    for (const variable of this.variables) {
      let sourceVar;
      try {
        sourceVar = await getValueTreeForExpression(this._callFrame, this._plugin, variable.name, ({
                                                      generatePreview: false,
                                                      includeCommandLineAPI: true,
                                                      objectGroup: 'backtrace',
                                                      returnByValue: false,
                                                      silent: false,
                                                    } as SDK.RuntimeModel.EvaluationOptions));
      } catch (e) {
        console.warn(e);
        sourceVar = new SDK.RemoteObject.LocalJSONObject(undefined);
      }
      if (variable.nestedName && variable.nestedName.length > 1) {
        let parent: {
          [x: string]: SDK.RemoteObject.RemoteObject,
        } = namespaces;
        for (let index = 0; index < variable.nestedName.length - 1; index++) {
          const nestedName = variable.nestedName[index];
          let child: NamespaceObject|SDK.RemoteObject.RemoteObject = parent[nestedName];
          if (!child) {
            child = new NamespaceObject({});
            parent[nestedName] = child;
          }
          parent = child.value;
        }
        const name = variable.nestedName[variable.nestedName.length - 1];
        parent[name] = sourceVar;
      } else {
        properties.push(makeProperty(variable.name, sourceVar));
      }
    }

    for (const namespace in namespaces) {
      properties.push(makeProperty(namespace, (namespaces[namespace] as SDK.RemoteObject.RemoteObject)));
    }

    return /** @type {!SDK.RemoteObject.GetPropertiesResult} */ {properties: properties, internalProperties: []} as
        SDK.RemoteObject.GetPropertiesResult;
  }
}

export class SourceScope implements SDK.DebuggerModel.ScopeChainEntry {
  _callFrame: SDK.DebuggerModel.CallFrame;
  _type: string;
  _typeName: string;
  _icon: string|undefined;
  _object: SourceScopeRemoteObject;
  _name: string;
  _startLocation: SDK.DebuggerModel.Location|null;
  _endLocation: SDK.DebuggerModel.Location|null;
  constructor(
      callFrame: SDK.DebuggerModel.CallFrame, type: string, typeName: string, icon: string|undefined,
      plugin: DebuggerLanguagePlugin, location: RawLocation) {
    this._callFrame = callFrame;
    this._type = type;
    this._typeName = typeName;
    this._icon = icon;
    this._object = new SourceScopeRemoteObject(callFrame, plugin, location);
    this._name = type;
    this._startLocation = null;
    this._endLocation = null;
  }

  async getVariableValue(name: string): Promise<SDK.RemoteObject.RemoteObject|null> {
    for (let v = 0; v < this._object.variables.length; ++v) {
      if (this._object.variables[v].name !== name) {
        continue;
      }
      const properties = await this._object.getAllProperties(false, false);
      if (!properties.properties) {
        continue;
      }
      const {value} = properties.properties[v];
      if (value) {
        return value;
      }
    }
    return null;
  }

  callFrame(): SDK.DebuggerModel.CallFrame {
    return this._callFrame;
  }

  type(): string {
    return this._type;
  }

  typeName(): string {
    return this._typeName;
  }

  name(): string|undefined {
    return undefined;
  }

  startLocation(): SDK.DebuggerModel.Location|null {
    return this._startLocation;
  }

  endLocation(): SDK.DebuggerModel.Location|null {
    return this._endLocation;
  }

  object(): SourceScopeRemoteObject {
    return this._object;
  }

  description(): string {
    return '';
  }

  icon(): string|undefined {
    return this._icon;
  }
}

export class DebuggerLanguagePluginManager implements
    SDK.TargetManager.SDKModelObserver<SDK.DebuggerModel.DebuggerModel> {
  _workspace: Workspace.Workspace.WorkspaceImpl;
  _debuggerWorkspaceBinding: DebuggerWorkspaceBinding;
  _plugins: DebuggerLanguagePlugin[];
  _debuggerModelToData: Map<SDK.DebuggerModel.DebuggerModel, ModelData>;
  _rawModuleHandles: Map<string, {
    rawModuleId: string,
    plugin: DebuggerLanguagePlugin,
    scripts: Array<SDK.Script.Script>,
    addRawModulePromise: Promise<Array<string>>,
  }>;

  constructor(
      targetManager: SDK.TargetManager.TargetManager, workspace: Workspace.Workspace.WorkspaceImpl,
      debuggerWorkspaceBinding: DebuggerWorkspaceBinding) {
    this._workspace = workspace;
    this._debuggerWorkspaceBinding = debuggerWorkspaceBinding;

    this._plugins = [];

    this._debuggerModelToData = new Map();
    targetManager.observeModels(SDK.DebuggerModel.DebuggerModel, this);

    this._rawModuleHandles = new Map();
  }

  async _evaluateOnCallFrame(callFrame: SDK.DebuggerModel.CallFrame, options: SDK.RuntimeModel.EvaluationOptions):
      Promise<{
        object: SDK.RemoteObject.RemoteObject,
        exceptionDetails: Protocol.Runtime.ExceptionDetails|undefined,
      }|{
        error: string,
      }|null> {
    const {script} = callFrame;
    const {expression} = options;
    const {plugin} = await this._rawModuleIdAndPluginForScript(script);
    if (!plugin) {
      return null;
    }
    const location = getRawLocation(callFrame);
    const sourceLocations = await plugin.rawLocationToSourceLocation(location);
    if (sourceLocations.length === 0) {
      return null;
    }

    try {
      const object = await getValueTreeForExpression(callFrame, plugin, expression, options);
      return {object, exceptionDetails: undefined};
    } catch (error) {
      if (error instanceof FormattingError) {
        const {exception: object, exceptionDetails} = error;
        return {object, exceptionDetails};
      }
      return {error: error.message};
    }
  }

  _expandCallFrames(callFrames: SDK.DebuggerModel.CallFrame[]): Promise<SDK.DebuggerModel.CallFrame[]> {
    return Promise
        .all(callFrames.map(async callFrame => {
          const functionInfo = await this.getFunctionInfo(callFrame.script, callFrame.location());
          if (functionInfo) {
            const {frames, missingSymbolFiles} = functionInfo;
            if (frames.length) {
              return frames.map(({name}, index) => callFrame.createVirtualCallFrame(index, name));
            }
            if (missingSymbolFiles && missingSymbolFiles.length) {
              for (const file of missingSymbolFiles) {
                callFrame.addWarning(i18nString(UIStrings.symbolFileNotFound, {PH1: file}));
              }
            }
            callFrame.addWarning(
                i18nString(UIStrings.failedToLoadDebugSymbolsForFunction, {PH1: callFrame.functionName}));
          }
          return callFrame;
        }))
        .then(callFrames => callFrames.flat());
  }

  modelAdded(debuggerModel: SDK.DebuggerModel.DebuggerModel): void {
    this._debuggerModelToData.set(debuggerModel, new ModelData(debuggerModel, this._workspace));
    debuggerModel.addEventListener(SDK.DebuggerModel.Events.GlobalObjectCleared, this._globalObjectCleared, this);
    debuggerModel.addEventListener(SDK.DebuggerModel.Events.ParsedScriptSource, this._parsedScriptSource, this);
    debuggerModel.setEvaluateOnCallFrameCallback(this._evaluateOnCallFrame.bind(this));
    debuggerModel.setExpandCallFramesCallback(this._expandCallFrames.bind(this));
  }

  modelRemoved(debuggerModel: SDK.DebuggerModel.DebuggerModel): void {
    debuggerModel.removeEventListener(SDK.DebuggerModel.Events.GlobalObjectCleared, this._globalObjectCleared, this);
    debuggerModel.removeEventListener(SDK.DebuggerModel.Events.ParsedScriptSource, this._parsedScriptSource, this);
    debuggerModel.setEvaluateOnCallFrameCallback(null);
    debuggerModel.setExpandCallFramesCallback(null);
    const modelData = this._debuggerModelToData.get(debuggerModel);
    if (modelData) {
      modelData._dispose();
      this._debuggerModelToData.delete(debuggerModel);
    }
    this._rawModuleHandles.forEach((rawModuleHandle, rawModuleId) => {
      const scripts = rawModuleHandle.scripts.filter(script => script.debuggerModel !== debuggerModel);
      if (scripts.length === 0) {
        rawModuleHandle.plugin.removeRawModule(rawModuleId).catch(error => {
          Common.Console.Console.instance().error(
              i18nString(UIStrings.errorInDebuggerLanguagePlugin, {PH1: error.message}));
        });
        this._rawModuleHandles.delete(rawModuleId);
      } else {
        rawModuleHandle.scripts = scripts;
      }
    });
  }

  _globalObjectCleared(event: Common.EventTarget.EventTargetEvent): void {
    const debuggerModel = (event.data as SDK.DebuggerModel.DebuggerModel);
    this.modelRemoved(debuggerModel);
    this.modelAdded(debuggerModel);
  }

  addPlugin(plugin: DebuggerLanguagePlugin): void {
    this._plugins.push(plugin);
    for (const debuggerModel of this._debuggerModelToData.keys()) {
      for (const script of debuggerModel.scripts()) {
        if (this.hasPluginForScript(script)) {
          continue;
        }
        this._parsedScriptSource({data: script});
      }
    }
  }

  removePlugin(plugin: DebuggerLanguagePlugin): void {
    this._plugins = this._plugins.filter(p => p !== plugin);
    const scripts = new Set<SDK.Script.Script>();
    this._rawModuleHandles.forEach((rawModuleHandle, rawModuleId) => {
      if (rawModuleHandle.plugin !== plugin) {
        return;
      }
      rawModuleHandle.scripts.forEach(script => scripts.add(script));
      this._rawModuleHandles.delete(rawModuleId);
    });
    for (const script of scripts) {
      const modelData = (this._debuggerModelToData.get(script.debuggerModel) as ModelData);
      modelData._removeScript(script);

      // Let's see if we have another plugin that's happy to
      // take this orphaned script now. This is important to
      // get right, since the same plugin might race during
      // unregister/register and we might already have the
      // new instance of the plugin added before we remove
      // the previous instance.
      this._parsedScriptSource({data: script});
    }
  }

  hasPluginForScript(script: SDK.Script.Script): boolean {
    const rawModuleId = rawModuleIdForScript(script);
    const rawModuleHandle = this._rawModuleHandles.get(rawModuleId);
    return rawModuleHandle !== undefined && rawModuleHandle.scripts.includes(script);
  }

  /**
   * Returns the responsible language plugin and the raw module ID for a script.
   *
   * This ensures that the `addRawModule` call finishes first such that the
   * caller can immediately issue calls to the returned plugin without the
   * risk of racing with the `addRawModule` call. The returned plugin will be
   * set to undefined to indicate that there's no plugin for the script.
   */
  async _rawModuleIdAndPluginForScript(script: SDK.Script.Script): Promise<{
    rawModuleId: string,
    plugin: DebuggerLanguagePlugin|null,
  }> {
    const rawModuleId = rawModuleIdForScript(script);
    const rawModuleHandle = this._rawModuleHandles.get(rawModuleId);
    if (rawModuleHandle) {
      await rawModuleHandle.addRawModulePromise;
      if (rawModuleHandle === this._rawModuleHandles.get(rawModuleId)) {
        return {rawModuleId, plugin: rawModuleHandle.plugin};
      }
    }
    return {rawModuleId, plugin: null};
  }

  uiSourceCodeForURL(debuggerModel: SDK.DebuggerModel.DebuggerModel, url: string): Workspace.UISourceCode.UISourceCode
      |null {
    const modelData = this._debuggerModelToData.get(debuggerModel);
    if (modelData) {
      return modelData._project.uiSourceCodeForURL(url);
    }
    return null;
  }

  async rawLocationToUILocation(rawLocation: SDK.DebuggerModel.Location):
      Promise<Workspace.UISourceCode.UILocation|null> {
    const script = rawLocation.script();
    if (!script) {
      return null;
    }
    const {rawModuleId, plugin} = await this._rawModuleIdAndPluginForScript(script);
    if (!plugin) {
      return null;
    }

    const pluginLocation = {
      rawModuleId,
      // RawLocation.columnNumber is the byte offset in the full raw wasm module. Plugins expect the offset in the code
      // section, so subtract the offset of the code section in the module here.
      codeOffset: rawLocation.columnNumber - (script.codeOffset() || 0),
      inlineFrameIndex: rawLocation.inlineFrameIndex,
    };

    try {
      const sourceLocations = await plugin.rawLocationToSourceLocation(pluginLocation);
      for (const sourceLocation of sourceLocations) {
        const uiSourceCode = this.uiSourceCodeForURL(script.debuggerModel, sourceLocation.sourceFileURL);
        if (!uiSourceCode) {
          continue;
        }
        // Absence of column information is indicated by the value `-1` in talking to language plugins.
        return uiSourceCode.uiLocation(
            sourceLocation.lineNumber, sourceLocation.columnNumber >= 0 ? sourceLocation.columnNumber : undefined);
      }
    } catch (error) {
      Common.Console.Console.instance().error(
          i18nString(UIStrings.errorInDebuggerLanguagePlugin, {PH1: error.message}));
    }
    return null;
  }

  uiLocationToRawLocationRanges(
      uiSourceCode: Workspace.UISourceCode.UISourceCode, lineNumber: number,
      columnNumber: number|undefined = -1): Promise<{
    start: SDK.DebuggerModel.Location,
    end: SDK.DebuggerModel.Location,
  }[]|null> {
    const locationPromises: Promise<{
      start: SDK.DebuggerModel.Location,
      end: SDK.DebuggerModel.Location,
    }[]>[] = [];
    this.scriptsForUISourceCode(uiSourceCode).forEach(script => {
      const rawModuleId = rawModuleIdForScript(script);
      const rawModuleHandle = this._rawModuleHandles.get(rawModuleId);
      if (!rawModuleHandle) {
        return;
      }
      const {plugin} = rawModuleHandle;
      locationPromises.push(getLocations(rawModuleId, plugin, script));
    });
    if (locationPromises.length === 0) {
      return Promise.resolve(null);
    }

    return Promise.all(locationPromises).then(locations => locations.flat()).catch(error => {
      Common.Console.Console.instance().error(
          i18nString(UIStrings.errorInDebuggerLanguagePlugin, {PH1: error.message}));
      return null;
    });

    async function getLocations(
        rawModuleId: string, plugin: DebuggerLanguagePlugin, script: SDK.Script.Script): Promise<{
      start: SDK.DebuggerModel.Location,
      end: SDK.DebuggerModel.Location,
    }[]> {
      const pluginLocation = {rawModuleId, sourceFileURL: uiSourceCode.url(), lineNumber, columnNumber};

      const rawLocations = await plugin.sourceLocationToRawLocation(pluginLocation);
      if (!rawLocations) {
        return [];
      }
      return rawLocations.map(
          m => ({
            start: new SDK.DebuggerModel.Location(
                script.debuggerModel, script.scriptId, 0, Number(m.startOffset) + (script.codeOffset() || 0)),
            end: new SDK.DebuggerModel.Location(
                script.debuggerModel, script.scriptId, 0, Number(m.endOffset) + (script.codeOffset() || 0)),
          }));
    }
  }

  async uiLocationToRawLocations(
      uiSourceCode: Workspace.UISourceCode.UISourceCode, lineNumber: number,
      columnNumber?: number): Promise<SDK.DebuggerModel.Location[]|null> {
    const locationRanges = await this.uiLocationToRawLocationRanges(uiSourceCode, lineNumber, columnNumber);
    if (!locationRanges) {
      return null;
    }
    return locationRanges.map(({start}) => start);
  }

  scriptsForUISourceCode(uiSourceCode: Workspace.UISourceCode.UISourceCode): SDK.Script.Script[] {
    for (const modelData of this._debuggerModelToData.values()) {
      const scripts = modelData._uiSourceCodeToScripts.get(uiSourceCode);
      if (scripts) {
        return scripts;
      }
    }
    return [];
  }

  _parsedScriptSource(event: Common.EventTarget.EventTargetEvent): void {
    const script = (event.data as SDK.Script.Script);
    if (!script.sourceURL) {
      return;
    }

    for (const plugin of this._plugins) {
      if (!plugin.handleScript(script)) {
        return;
      }
      const rawModuleId = rawModuleIdForScript(script);
      let rawModuleHandle = this._rawModuleHandles.get(rawModuleId);
      if (!rawModuleHandle) {
        const sourceFileURLsPromise = (async(): Promise<string[]> => {
          const console = Common.Console.Console.instance();
          const url = script.sourceURL;
          const symbolsUrl = (script.debugSymbols && script.debugSymbols.externalURL) || '';
          if (symbolsUrl) {
            console.log(i18nString(UIStrings.loadingDebugSymbolsForVia, {PH1: plugin.name, PH2: url, PH3: symbolsUrl}));
          } else {
            console.log(i18nString(UIStrings.loadingDebugSymbolsFor, {PH1: plugin.name, PH2: url}));
          }
          try {
            const code = (!symbolsUrl && url.startsWith('wasm://')) ? await script.getWasmBytecode() : undefined;
            const sourceFileURLs = await plugin.addRawModule(rawModuleId, symbolsUrl, {url, code});
            // Check that the handle isn't stale by now. This works because the code that assigns to
            // `rawModuleHandle` below will run before this code because of the `await` in the preceding
            // line. This is primarily to avoid logging the message below, which would give the developer
            // the misleading information that we're done, while in reality it was a stale call that finished.
            if (rawModuleHandle !== this._rawModuleHandles.get(rawModuleId)) {
              return [];
            }
            if (sourceFileURLs.length === 0) {
              console.warn(i18nString(UIStrings.loadedDebugSymbolsForButDidnt, {PH1: plugin.name, PH2: url}));
            } else {
              console.log(i18nString(
                  UIStrings.loadedDebugSymbolsForFound, {PH1: plugin.name, PH2: url, PH3: sourceFileURLs.length}));
            }
            return sourceFileURLs;
          } catch (error) {
            console.error(
                i18nString(UIStrings.failedToLoadDebugSymbolsFor, {PH1: plugin.name, PH2: url, PH3: error.message}));
            this._rawModuleHandles.delete(rawModuleId);
            return [];
          }
        })();
        rawModuleHandle = {rawModuleId, plugin, scripts: [script], addRawModulePromise: sourceFileURLsPromise};
        this._rawModuleHandles.set(rawModuleId, rawModuleHandle);
      } else {
        rawModuleHandle.scripts.push(script);
      }

      // Wait for the addRawModule call to finish and
      // update the project. It's important to check
      // for the DebuggerModel again, which may disappear
      // in the meantime...
      rawModuleHandle.addRawModulePromise.then(sourceFileURLs => {
        // The script might have disappeared meanwhile...
        if (script.debuggerModel.scriptForId(script.scriptId) === script) {
          const modelData = this._debuggerModelToData.get(script.debuggerModel);
          if (modelData) {  // The DebuggerModel could have disappeared meanwhile...
            modelData._addSourceFiles(script, sourceFileURLs);
            this._debuggerWorkspaceBinding.updateLocations(script);
          }
        }
      });
      return;
    }
  }

  async resolveScopeChain(callFrame: SDK.DebuggerModel.CallFrame): Promise<SourceScope[]|null> {
    const script = callFrame.script;
    const {rawModuleId, plugin} = await this._rawModuleIdAndPluginForScript(script);
    if (!plugin) {
      return null;
    }

    const location = {
      rawModuleId,
      codeOffset: callFrame.location().columnNumber - (script.codeOffset() || 0),
      inlineFrameIndex: callFrame.inlineFrameIndex,
    };

    try {
      const sourceMapping = await plugin.rawLocationToSourceLocation(location);
      if (sourceMapping.length === 0) {
        return null;
      }
      const scopes = new Map<string, SourceScope>();
      const variables = await plugin.listVariablesInScope(location);
      for (const variable of variables || []) {
        let scope = scopes.get(variable.scope);
        if (!scope) {
          const {type, typeName, icon} = await plugin.getScopeInfo(variable.scope);
          scope = new SourceScope(callFrame, type, typeName, icon, plugin, location);
          scopes.set(variable.scope, scope);
        }
        scope.object().variables.push(variable);
      }
      return Array.from(scopes.values());
    } catch (error) {
      Common.Console.Console.instance().error(
          i18nString(UIStrings.errorInDebuggerLanguagePlugin, {PH1: error.message}));
      return null;
    }
  }

  async getFunctionInfo(script: SDK.Script.Script, location: SDK.DebuggerModel.Location): Promise<{
    frames: Array<FunctionInfo>,
    missingSymbolFiles?: Array<string>,
  }|null> {
    const {rawModuleId, plugin} = await this._rawModuleIdAndPluginForScript(script);
    if (!plugin) {
      return null;
    }

    const rawLocation: RawLocation = {
      rawModuleId,
      codeOffset: location.columnNumber - (script.codeOffset() || 0),
      inlineFrameIndex: 0,
    };

    try {
      return await plugin.getFunctionInfo(rawLocation);
    } catch (error) {
      Common.Console.Console.instance().warn(i18nString(UIStrings.errorInDebuggerLanguagePlugin, {PH1: error.message}));
      return {frames: []};
    }
  }

  async getInlinedFunctionRanges(rawLocation: SDK.DebuggerModel.Location): Promise<{
    start: SDK.DebuggerModel.Location,
    end: SDK.DebuggerModel.Location,
  }[]> {
    const script = rawLocation.script();
    if (!script) {
      return [];
    }
    const {rawModuleId, plugin} = await this._rawModuleIdAndPluginForScript(script);
    if (!plugin) {
      return [];
    }

    const pluginLocation = {
      rawModuleId,
      // RawLocation.columnNumber is the byte offset in the full raw wasm module. Plugins expect the offset in the code
      // section, so subtract the offset of the code section in the module here.
      codeOffset: rawLocation.columnNumber - (script.codeOffset() || 0),
    };

    try {
      // TODO(crbug.com/1172300) Ignored during the jsdoc to ts migration)
      // @ts-ignore
      const locations = await plugin.getInlinedFunctionRanges(pluginLocation);
      return locations.map(
          m => ({
            start: new SDK.DebuggerModel.Location(
                script.debuggerModel, script.scriptId, 0, Number(m.startOffset) + (script.codeOffset() || 0)),
            end: new SDK.DebuggerModel.Location(
                script.debuggerModel, script.scriptId, 0, Number(m.endOffset) + (script.codeOffset() || 0)),
          }));
    } catch (error) {
      Common.Console.Console.instance().warn(i18nString(UIStrings.errorInDebuggerLanguagePlugin, {PH1: error.message}));
      return [];
    }
  }

  async getInlinedCalleesRanges(rawLocation: SDK.DebuggerModel.Location): Promise<{
    start: SDK.DebuggerModel.Location,
    end: SDK.DebuggerModel.Location,
  }[]> {
    const script = rawLocation.script();
    if (!script) {
      return [];
    }
    const {rawModuleId, plugin} = await this._rawModuleIdAndPluginForScript(script);
    if (!plugin) {
      return [];
    }

    const pluginLocation = {
      rawModuleId,
      // RawLocation.columnNumber is the byte offset in the full raw wasm module. Plugins expect the offset in the code
      // section, so subtract the offset of the code section in the module here.
      codeOffset: rawLocation.columnNumber - (script.codeOffset() || 0),
    };

    try {
      // TODO(crbug.com/1172300) Ignored during the jsdoc to ts migration)
      // @ts-ignore
      const locations = await plugin.getInlinedCalleesRanges(pluginLocation);
      return locations.map(
          m => ({
            start: new SDK.DebuggerModel.Location(
                script.debuggerModel, script.scriptId, 0, Number(m.startOffset) + (script.codeOffset() || 0)),
            end: new SDK.DebuggerModel.Location(
                script.debuggerModel, script.scriptId, 0, Number(m.endOffset) + (script.codeOffset() || 0)),
          }));
    } catch (error) {
      Common.Console.Console.instance().warn(i18nString(UIStrings.errorInDebuggerLanguagePlugin, {PH1: error.message}));
      return [];
    }
  }

  async getMappedLines(uiSourceCode: Workspace.UISourceCode.UISourceCode): Promise<Set<number>|undefined> {
    const rawModuleIds =
        await Promise.all(this.scriptsForUISourceCode(uiSourceCode).map(s => this._rawModuleIdAndPluginForScript(s)));

    let mappedLines: Set<number>|undefined;
    for (const {rawModuleId, plugin} of rawModuleIds) {
      if (!plugin) {
        continue;
      }
      const lines = await plugin.getMappedLines(rawModuleId, uiSourceCode.url());

      if (lines === undefined) {
        continue;
      }
      if (mappedLines === undefined) {
        mappedLines = new Set(lines);
      } else {
        /**
         * @param {number} l
         */
        lines.forEach(l => (mappedLines as Set<number>).add(l));
      }
    }
    return mappedLines;
  }
}

class ModelData {
  _debuggerModel: SDK.DebuggerModel.DebuggerModel;
  _project: ContentProviderBasedProject;
  _uiSourceCodeToScripts: Map<Workspace.UISourceCode.UISourceCode, SDK.Script.Script[]>;
  constructor(debuggerModel: SDK.DebuggerModel.DebuggerModel, workspace: Workspace.Workspace.WorkspaceImpl) {
    this._debuggerModel = debuggerModel;
    this._project = new ContentProviderBasedProject(
        workspace, 'language_plugins::' + debuggerModel.target().id(), Workspace.Workspace.projectTypes.Network, '',
        false /* isServiceProject */);
    NetworkProject.setTargetForProject(this._project, debuggerModel.target());

    this._uiSourceCodeToScripts = new Map();
  }

  _addSourceFiles(script: SDK.Script.Script, urls: string[]): void {
    const initiator = script.createPageResourceLoadInitiator();
    for (const url of urls) {
      let uiSourceCode = this._project.uiSourceCodeForURL(url);
      if (!uiSourceCode) {
        uiSourceCode = this._project.createUISourceCode(url, Common.ResourceType.resourceTypes.SourceMapScript);
        NetworkProject.setInitialFrameAttribution(uiSourceCode, script.frameId);

        // Bind the uiSourceCode to the script first before we add the
        // uiSourceCode to the project and thereby notify the rest of
        // the system about the new source file.
        // https://crbug.com/1150295 is an example where the breakpoint
        // resolution logic kicks in right after adding the uiSourceCode
        // and at that point we already need to have the mapping in place
        // otherwise we will not get the breakpoint right.
        this._uiSourceCodeToScripts.set(uiSourceCode, [script]);

        const contentProvider = new SDK.CompilerSourceMappingContentProvider.CompilerSourceMappingContentProvider(
            url, Common.ResourceType.resourceTypes.SourceMapScript, initiator);
        const mimeType = Common.ResourceType.ResourceType.mimeFromURL(url) || 'text/javascript';
        this._project.addUISourceCodeWithProvider(uiSourceCode, contentProvider, null, mimeType);
      } else {
        // The same uiSourceCode can be provided by different scripts,
        // but we don't expect that to happen frequently.
        const scripts = (this._uiSourceCodeToScripts.get(uiSourceCode) as SDK.Script.Script[]);
        if (!scripts.includes(script)) {
          scripts.push(script);
        }
      }
    }
  }

  _removeScript(script: SDK.Script.Script): void {
    this._uiSourceCodeToScripts.forEach((scripts, uiSourceCode) => {
      scripts = scripts.filter(s => s !== script);
      if (scripts.length === 0) {
        this._uiSourceCodeToScripts.delete(uiSourceCode);
        this._project.removeUISourceCode(uiSourceCode.url());
      } else {
        this._uiSourceCodeToScripts.set(uiSourceCode, scripts);
      }
    });
  }

  _dispose(): void {
    this._project.dispose();
  }
}
export interface RawModule {
  url: string;
  code?: ArrayBuffer;
}
export interface RawLocationRange {
  rawModuleId: string;
  startOffset: number;
  endOffset: number;
}
export interface RawLocation {
  rawModuleId: string;
  codeOffset: number;
  inlineFrameIndex: number;
}
export interface SourceLocation {
  rawModuleId: string;
  sourceFileURL: string;
  lineNumber: number;
  columnNumber: number;
}
export interface Variable {
  scope: string;
  name: string;
  type: string;
  nestedName: string[]|null;
}
export interface VariableValue {
  value: string|VariableValue[];
  // eslint-disable-next-line @typescript-eslint/naming-convention
  js_type: string;
  type: string;
  name: string;
}
export interface EvaluatorModule {
  code?: ArrayBuffer;
  constantValue?: VariableValue;
}
export interface ScopeInfo {
  type: string;
  typeName: string;
  icon?: string;
}
export interface FunctionInfo {
  name: string;
}
export interface FieldInfo {
  name?: string;
  offset: number;
  // TODO(crbug.com/1172300) Ignored during the jsdoc to ts migration)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typeId: any;
}
export interface TypeInfo {
  typeNames: string[];
  // TODO(crbug.com/1172300) Ignored during the jsdoc to ts migration)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typeId: any;
  members: FieldInfo[];
  alignment: number;
  arraySize: number;
  size: number;
  canExpand: boolean;
  hasValue: boolean;
}
export interface EvalBase {
  rootType: TypeInfo;
  // TODO(crbug.com/1172300) Ignored during the jsdoc to ts migration)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
}

export class DebuggerLanguagePlugin {
  name: string;
  constructor(name: string) {
    this.name = name;
  }

  handleScript(_script: SDK.Script.Script): boolean {
    throw new Error('Not implemented yet');
  }

  dispose(): void {
  }

  /** Notify the plugin about a new script
    */
  async addRawModule(_rawModuleId: string, _symbolsURL: string, _rawModule: RawModule): Promise<string[]> {
    throw new Error('Not implemented yet');
  }

  /** Find locations in raw modules from a location in a source file
    */
  async sourceLocationToRawLocation(_sourceLocation: SourceLocation): Promise<RawLocationRange[]> {
    throw new Error('Not implemented yet');
  }

  /** Find locations in source files from a location in a raw module
    */
  async rawLocationToSourceLocation(_rawLocation: RawLocation): Promise<SourceLocation[]> {
    throw new Error('Not implemented yet');
  }

  /** Return detailed information about a scope
     */
  async getScopeInfo(_type: string): Promise<ScopeInfo> {
    throw new Error('Not implemented yet');
  }

  /** List all variables in lexical scope at a given location in a raw module
    */
  async listVariablesInScope(_rawLocation: RawLocation): Promise<Variable[]> {
    throw new Error('Not implemented yet');
  }

  /**
   * Notifies the plugin that a script is removed.
   */
  removeRawModule(_rawModuleId: string): Promise<void> {
    throw new Error('Not implemented yet');
  }

  getTypeInfo(_expression: string, _context: RawLocation): Promise<{
    typeInfos: Array<TypeInfo>,
    base: EvalBase,
  }|null> {
    throw new Error('Not implemented yet');
  }

  getFormatter(
      _expressionOrField: string|{
        base: EvalBase,
        field: Array<FieldInfo>,
      },
      _context: RawLocation): Promise<{
    js: string,
  }|null> {
    throw new Error('Not implemented yet');
  }

  getInspectableAddress(_field: {
    base: EvalBase,
    field: Array<FieldInfo>,
  }): Promise<{
    js: string,
  }> {
    throw new Error('Not implemented yet');
  }

  /**
   * Find locations in source files from a location in a raw module
   */
  async getFunctionInfo(_rawLocation: RawLocation): Promise<{
    frames: Array<FunctionInfo>,
    missingSymbolFiles?: Array<string>,
  }> {
    throw new Error('Not implemented yet');
  }

  /**
   * Find locations in raw modules corresponding to the inline function
   * that rawLocation is in. Used for stepping out of an inline function.
   */
  async getInlinedFunctionRanges(_rawLocation: RawLocation): Promise<RawLocationRange[]> {
    throw new Error('Not implemented yet');
  }

  /**
   * Find locations in raw modules corresponding to inline functions
   * called by the function or inline frame that rawLocation is in.
   * Used for stepping over inline functions.
   */
  async getInlinedCalleesRanges(_rawLocation: RawLocation): Promise<RawLocationRange[]> {
    throw new Error('Not implemented yet');
  }

  async getMappedLines(_rawModuleId: string, _sourceFileURL: string): Promise<number[]|undefined> {
    throw new Error('Not implemented yet');
  }
}
