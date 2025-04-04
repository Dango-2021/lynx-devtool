/*
 * Copyright (C) 2014 Google Inc. All rights reserved.
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
import * as Platform from '../../core/platform/platform.js';
import type * as Protocol from '../../generated/protocol.js';

import type * as SDK from '../../core/sdk/sdk.js';
import * as UI from '../../ui/legacy/legacy.js';

import type {LayerView, LayerViewHost} from './LayerViewHost.js';
import {LayerSelection, Selection, SnapshotSelection, Type, ScrollRectSelection} from './LayerViewHost.js';
import {Events as TransformControllerEvents, TransformController} from './TransformController.js';

const UIStrings = {
  /**
  *@description Text of a DOM element in DView of the Layers panel
  */
  layerInformationIsNotYet: 'Layer information is not yet available.',
  /**
  *@description Accessibility label for canvas view in Layers tool
  */
  dLayersView: '3D Layers View',
  /**
  *@description Text in DView of the Layers panel
  */
  cantDisplayLayers: 'Can\'t display layers,',
  /**
  *@description Text in DView of the Layers panel
  */
  webglSupportIsDisabledInYour: 'WebGL support is disabled in your browser.',
  /**
  *@description Text in DView of the Layers panel
  *@example {about:gpu} PH1
  */
  checkSForPossibleReasons: 'Check {PH1} for possible reasons.',
  /**
  *@description Text for a checkbox in the toolbar of the Layers panel to show the area of slow scroll rect
  */
  slowScrollRects: 'Slow scroll rects',
  /**
  * @description Text for a checkbox in the toolbar of the Layers panel. This is a noun, for a
  * setting meaning 'display paints in the layers viewer'. 'Paints' here means 'paint events' i.e.
  * when the browser draws pixels to the screen.
  */
  paints: 'Paints',
  /**
  *@description A context menu item in the DView of the Layers panel
  */
  resetView: 'Reset View',
  /**
  *@description A context menu item in the DView of the Layers panel
  */
  showPaintProfiler: 'Show Paint Profiler',
};
const str_ = i18n.i18n.registerUIStrings('panels/layer_viewer/Layers3DView.ts', UIStrings);
const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);

const vertexPositionAttributes = new Map<WebGLProgram, number>();

const vertexColorAttributes = new Map<WebGLProgram, number>();

const textureCoordAttributes = new Map<WebGLProgram, number>();

const uniformMatrixLocations = new Map<WebGLProgram, WebGLUniformLocation|null>();

const uniformSamplerLocations = new Map<WebGLProgram, WebGLUniformLocation|null>();

const imageForTexture = new Map<WebGLTexture, HTMLImageElement>();

export class Layers3DView extends UI.Widget.VBox implements LayerView {
  _failBanner: UI.Widget.VBox;
  _layerViewHost: LayerViewHost;
  _transformController: TransformController;
  _canvasElement: HTMLCanvasElement;
  _lastSelection: {[x: string]: Selection|null};
  _layerTree: SDK.LayerTreeBase.LayerTreeBase|null;
  _textureManager: LayerTextureManager;
  _chromeTextures: (WebGLTexture|undefined)[];
  _rects: Rectangle[];
  _snapshotLayers: Map<SDK.LayerTreeBase.Layer, SnapshotSelection>;
  _shaderProgram!: WebGLProgram|null;
  _oldTextureScale!: number|undefined;
  _depthByLayerId!: Map<string, number>;
  _visibleLayers!: Set<SDK.LayerTreeBase.Layer>;
  _maxDepth!: number;
  _scale!: number;
  _layerTexture?: {layer: SDK.LayerTreeBase.Layer, texture: WebGLTexture}|null;
  _projectionMatrix?: DOMMatrix;
  _whiteTexture?: WebGLTexture|null;
  _gl?: WebGLRenderingContext|null;
  _dimensionsForAutoscale?: {width: number, height: number};
  _needsUpdate?: boolean;
  _panelToolbar?: UI.Toolbar.Toolbar;
  _showSlowScrollRectsSetting?: Common.Settings.Setting<boolean>;
  _showPaintsSetting?: Common.Settings.Setting<boolean>;
  _mouseDownX?: number;
  _mouseDownY?: number;

  constructor(layerViewHost: LayerViewHost) {
    super(true);

    this.registerRequiredCSS('panels/layer_viewer/layers3DView.css');
    this.contentElement.classList.add('layers-3d-view');
    this._failBanner = new UI.Widget.VBox();
    this._failBanner.element.classList.add('full-widget-dimmed-banner');
    UI.UIUtils.createTextChild(this._failBanner.element, i18nString(UIStrings.layerInformationIsNotYet));

    this._layerViewHost = layerViewHost;
    this._layerViewHost.registerView(this);
    this._transformController = new TransformController(this.contentElement as HTMLElement);
    this._transformController.addEventListener(TransformControllerEvents.TransformChanged, this._update, this);
    this._initToolbar();
    this._canvasElement = this.contentElement.createChild('canvas') as HTMLCanvasElement;
    this._canvasElement.tabIndex = 0;
    this._canvasElement.addEventListener('dblclick', this._onDoubleClick.bind(this), false);
    this._canvasElement.addEventListener('mousedown', this._onMouseDown.bind(this), false);
    this._canvasElement.addEventListener('mouseup', this._onMouseUp.bind(this), false);
    this._canvasElement.addEventListener('mouseleave', this._onMouseMove.bind(this), false);
    this._canvasElement.addEventListener('mousemove', this._onMouseMove.bind(this), false);
    this._canvasElement.addEventListener('contextmenu', this._onContextMenu.bind(this), false);
    UI.ARIAUtils.setAccessibleName(this._canvasElement, i18nString(UIStrings.dLayersView));

    this._lastSelection = {};
    this._layerTree = null;

    this._textureManager = new LayerTextureManager(this._update.bind(this));

    this._chromeTextures = [];

    this._rects = [];

    this._snapshotLayers = new Map();
    this._layerViewHost.setLayerSnapshotMap(this._snapshotLayers);

    this._layerViewHost.showInternalLayersSetting().addChangeListener(this._update, this);
  }

  setLayerTree(layerTree: SDK.LayerTreeBase.LayerTreeBase|null): void {
    this._layerTree = layerTree;
    this._layerTexture = null;
    delete this._oldTextureScale;
    if (this._showPaints()) {
      this._textureManager.setLayerTree(layerTree);
    }
    this._update();
  }

  showImageForLayer(layer: SDK.LayerTreeBase.Layer, imageURL?: string): void {
    if (!imageURL) {
      this._layerTexture = null;
      this._update();
      return;
    }
    UI.UIUtils.loadImage(imageURL).then(image => {
      const texture = image && LayerTextureManager._createTextureForImage(this._gl || null, image);
      this._layerTexture = texture ? {layer: layer, texture: texture} : null;
      this._update();
    });
  }

  onResize(): void {
    this._resizeCanvas();
    this._update();
  }

  willHide(): void {
    this._textureManager.suspend();
  }

  wasShown(): void {
    this._textureManager.resume();
    if (!this._needsUpdate) {
      return;
    }
    this._resizeCanvas();
    this._update();
  }

  updateLayerSnapshot(layer: SDK.LayerTreeBase.Layer): void {
    this._textureManager.layerNeedsUpdate(layer);
  }

  _setOutline(type: OutlineType, selection: Selection|null): void {
    this._lastSelection[type] = selection;
    this._update();
  }

  hoverObject(selection: Selection|null): void {
    this._setOutline(OutlineType.Hovered, selection);
  }

  selectObject(selection: Selection|null): void {
    this._setOutline(OutlineType.Hovered, null);
    this._setOutline(OutlineType.Selected, selection);
  }

  snapshotForSelection(selection: Selection): Promise<SDK.PaintProfiler.SnapshotWithRect|null> {
    if (selection.type() === Type.Snapshot) {
      const snapshotWithRect = (selection as SnapshotSelection).snapshot();
      snapshotWithRect.snapshot.addReference();
      return /** @type {!Promise<?SDK.PaintProfiler.SnapshotWithRect>} */ Promise.resolve(snapshotWithRect) as
          Promise<SDK.PaintProfiler.SnapshotWithRect|null>;
    }
    if (selection.layer()) {
      const promise = selection.layer().snapshots()[0];
      if (promise !== undefined) {
        return promise;
      }
    }
    return /** @type {!Promise<?SDK.PaintProfiler.SnapshotWithRect>} */ Promise.resolve(null) as
        Promise<SDK.PaintProfiler.SnapshotWithRect|null>;
  }

  _initGL(canvas: HTMLCanvasElement): WebGLRenderingContext|null {
    const gl = canvas.getContext('webgl');
    if (!gl) {
      return null;
    }
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.enable(gl.DEPTH_TEST);
    return /** @type {!WebGLRenderingContext} */ gl as WebGLRenderingContext;
  }

  _createShader(type: number, script: string): void {
    if (!this._gl) {
      return;
    }

    const shader = this._gl.createShader(type);
    if (shader && this._shaderProgram) {
      this._gl.shaderSource(shader, script);
      this._gl.compileShader(shader);
      this._gl.attachShader(this._shaderProgram, shader);
    }
  }

  _initShaders(): void {
    if (!this._gl) {
      return;
    }

    this._shaderProgram = this._gl.createProgram();
    if (!this._shaderProgram) {
      return;
    }
    this._createShader(this._gl.FRAGMENT_SHADER, FragmentShader);
    this._createShader(this._gl.VERTEX_SHADER, VertexShader);
    this._gl.linkProgram(this._shaderProgram);
    this._gl.useProgram(this._shaderProgram);

    const aVertexPositionAttribute = this._gl.getAttribLocation(this._shaderProgram, 'aVertexPosition');
    this._gl.enableVertexAttribArray(aVertexPositionAttribute);
    vertexPositionAttributes.set(this._shaderProgram, aVertexPositionAttribute);

    const aVertexColorAttribute = this._gl.getAttribLocation(this._shaderProgram, 'aVertexColor');
    this._gl.enableVertexAttribArray(aVertexColorAttribute);
    vertexColorAttributes.set(this._shaderProgram, aVertexColorAttribute);

    const aTextureCoordAttribute = this._gl.getAttribLocation(this._shaderProgram, 'aTextureCoord');
    this._gl.enableVertexAttribArray(aTextureCoordAttribute);
    textureCoordAttributes.set(this._shaderProgram, aTextureCoordAttribute);

    const uMatrixLocation = this._gl.getUniformLocation(this._shaderProgram, 'uPMatrix');
    uniformMatrixLocations.set(this._shaderProgram, uMatrixLocation);

    const uSamplerLocation = this._gl.getUniformLocation(this._shaderProgram, 'uSampler');
    uniformSamplerLocations.set(this._shaderProgram, uSamplerLocation);
  }

  _resizeCanvas(): void {
    this._canvasElement.width = this._canvasElement.offsetWidth * window.devicePixelRatio;
    this._canvasElement.height = this._canvasElement.offsetHeight * window.devicePixelRatio;
  }

  _updateTransformAndConstraints(): void {
    const paddingFraction = 0.1;
    const dimensionsForAutoscale = this._dimensionsForAutoscale || {width: 0, height: 0};
    const viewport = this._layerTree ? this._layerTree.viewportSize() : null;
    const baseWidth = viewport ? viewport.width : dimensionsForAutoscale.width;
    const baseHeight = viewport ? viewport.height : dimensionsForAutoscale.height;
    const canvasWidth = this._canvasElement.width;
    const canvasHeight = this._canvasElement.height;
    const paddingX = canvasWidth * paddingFraction;
    const paddingY = canvasHeight * paddingFraction;
    const scaleX = (canvasWidth - 2 * paddingX) / baseWidth;
    const scaleY = (canvasHeight - 2 * paddingY) / baseHeight;
    const viewScale = Math.min(scaleX, scaleY);
    const minScaleConstraint =
        Math.min(baseWidth / dimensionsForAutoscale.width, baseHeight / dimensionsForAutoscale.width) / 2;
    this._transformController.setScaleConstraints(
        minScaleConstraint,
        10 / viewScale);  // 1/viewScale is 1:1 in terms of pixels, so allow zooming to 10x of native size
    const scale = this._transformController.scale();
    const rotateX = this._transformController.rotateX();
    const rotateY = this._transformController.rotateY();

    this._scale = scale * viewScale;
    const textureScale = Platform.NumberUtilities.clamp(this._scale, 0.1, 1);
    if (textureScale !== this._oldTextureScale) {
      this._oldTextureScale = textureScale;
      this._textureManager.setScale(textureScale);
      this.dispatchEventToListeners(Events.ScaleChanged, textureScale);
    }
    const scaleAndRotationMatrix = new WebKitCSSMatrix()
                                       .scale(scale, scale, scale)
                                       .translate(canvasWidth / 2, canvasHeight / 2, 0)
                                       .rotate(rotateX, rotateY, 0)
                                       .scale(viewScale, viewScale, viewScale)
                                       .translate(-baseWidth / 2, -baseHeight / 2, 0);

    let bounds;
    for (let i = 0; i < this._rects.length; ++i) {
      bounds = UI.Geometry.boundsForTransformedPoints(scaleAndRotationMatrix, this._rects[i].vertices, bounds);
    }

    if (bounds) {
      this._transformController.clampOffsets(
          (paddingX - bounds.maxX) / window.devicePixelRatio,
          (canvasWidth - paddingX - bounds.minX) / window.devicePixelRatio,
          (paddingY - bounds.maxY) / window.devicePixelRatio,
          (canvasHeight - paddingY - bounds.minY) / window.devicePixelRatio);
    }
    const offsetX = this._transformController.offsetX() * window.devicePixelRatio;
    const offsetY = this._transformController.offsetY() * window.devicePixelRatio;
    // Multiply to translation matrix on the right rather than translate (which would implicitly multiply on the left).
    this._projectionMatrix = new WebKitCSSMatrix().translate(offsetX, offsetY, 0).multiply(scaleAndRotationMatrix);

    const glProjectionMatrix = new WebKitCSSMatrix()
                                   .scale(1, -1, -1)
                                   .translate(-1, -1, 0)
                                   .scale(2 / this._canvasElement.width, 2 / this._canvasElement.height, 1 / 1000000)
                                   .multiply(this._projectionMatrix);

    if (this._shaderProgram) {
      const pMatrixUniform = uniformMatrixLocations.get(this._shaderProgram);
      if (this._gl && pMatrixUniform) {
        this._gl.uniformMatrix4fv(pMatrixUniform, false, this._arrayFromMatrix(glProjectionMatrix));
      }
    }
  }

  _arrayFromMatrix(m: DOMMatrix): Float32Array {
    return new Float32Array([
      m.m11,
      m.m12,
      m.m13,
      m.m14,
      m.m21,
      m.m22,
      m.m23,
      m.m24,
      m.m31,
      m.m32,
      m.m33,
      m.m34,
      m.m41,
      m.m42,
      m.m43,
      m.m44,
    ]);
  }

  _initWhiteTexture(): void {
    if (!this._gl) {
      return;
    }

    this._whiteTexture = this._gl.createTexture();
    this._gl.bindTexture(this._gl.TEXTURE_2D, this._whiteTexture);
    const whitePixel = new Uint8Array([255, 255, 255, 255]);
    this._gl.texImage2D(
        this._gl.TEXTURE_2D, 0, this._gl.RGBA, 1, 1, 0, this._gl.RGBA, this._gl.UNSIGNED_BYTE, whitePixel);
  }

  _initChromeTextures(): void {
    function loadChromeTexture(this: Layers3DView, index: ChromeTexture, url: string): void {
      UI.UIUtils.loadImage(url).then(image => {
        this._chromeTextures[index] =
            image && LayerTextureManager._createTextureForImage(this._gl || null, image) || undefined;
      });
    }
    loadChromeTexture.call(this, ChromeTexture.Left, 'Images/chromeLeft.avif');
    loadChromeTexture.call(this, ChromeTexture.Middle, 'Images/chromeMiddle.avif');
    loadChromeTexture.call(this, ChromeTexture.Right, 'Images/chromeRight.avif');
  }

  _initGLIfNecessary(): WebGLRenderingContext|null {
    if (this._gl) {
      return this._gl;
    }
    this._gl = this._initGL(this._canvasElement);
    if (!this._gl) {
      return null;
    }
    this._initShaders();
    this._initWhiteTexture();
    this._initChromeTextures();
    this._textureManager.setContext(this._gl);
    return this._gl;
  }

  // helper functions determine whether a point is in a rectangle
  _getCross(p1: DOMPoint, p2: DOMPoint, p: DOMPoint): number {
    return (p2.x - p1.x) * (p.y - p1.y) - (p.x - p1.x) * (p2.y - p1.y);
  }
  _isPointInRect(point: number[], rectPoints: number[]): boolean {
    // point is the target point coordinates
    // rectPoints is the coordinates of the four vertices of the target rectangle clockwise from the origin
    let points = [] as DOMPoint[];
    for (let i = 0; i < 8; i += 2) {
      points.push(new DOMPoint(Math.round(rectPoints[i]), Math.round(rectPoints[i+1])));
    }
    let quad = new DOMQuad(...points);
    let p = new DOMPoint(...point.map(value => Math.round(value)));
    // relative position between point and rect edges
    let top = this._getCross(quad.p1, quad.p2, p);
    let right = this._getCross(quad.p2, quad.p3, p);
    let bottom = this._getCross(quad.p3, quad.p4, p);
    let left = this._getCross(quad.p4, quad.p1, p);
    // should all > 0 if the point is inside
    let isPointInside = top * bottom > 0 && right * left > 0;
    if (isPointInside) {
      return true;
    }
    // {side} === 0 means point lies on {side}
    let topLeftPoint = !top && !left;
    let topEdge = !top && left * right > 0;
    let leftEdge = !left && top * bottom > 0;
    return topLeftPoint || topEdge || leftEdge;
  }

  _calculateDepthsAndVisibility(): void {
    /** @type {!Map<string, number>} */
    this._depthByLayerId = new Map();
    const showInternalLayers = this._layerViewHost.showInternalLayersSetting().get();
    if (!this._layerTree) {
      return;
    }
    const root =
        showInternalLayers ? this._layerTree.root() : (this._layerTree.contentRoot() || this._layerTree.root());
    if (!root) {
      return;
    }
    /** @type {!Set<!SDK.LayerTreeBase.Layer>} */
    this._visibleLayers = new Set();
    let depth = 0;
    let currentLayerNodes = [root];
    while (currentLayerNodes.length > 0) {
      let nextLayerNodes = [] as SDK.LayerTreeBase.Layer[];
      let siblingNodes = [] as SDK.LayerTreeBase.Layer[];
      for (let node of currentLayerNodes) {
        if (showInternalLayers || node.drawsContent()) {
          this._visibleLayers.add(node);
        }
        // If ​​the element width or height is 0, skip the occlusion calculation
        if (node.width() === 0 || node.height() === 0) {
          this._depthByLayerId.set(node.id(), depth);
          nextLayerNodes.push(...node.children());
          continue;
        }
        //  Calculate the coordinates of the rect vertex by offsetX, offsetY, width, height
        let nodePoint = node.quad().slice(0, 2);
        let nodeRectPoints = node.quad();
        // Check if there is any occlusion with all previous elements of the same level
        if (siblingNodes.length !== 0) {
          // If there is occlusion with any previous element of the same level, the display depth will increase
          let overlap = siblingNodes.some(siblingNode => {
            let siblingNodePoint = siblingNode.quad().slice(0, 2);
            let siblingNodeRectPoints = siblingNode.quad();
            return this._isPointInRect(nodePoint, siblingNodeRectPoints) || this._isPointInRect(siblingNodePoint, nodeRectPoints);
          });
          if (overlap) {
            depth += 2;
          }
        }
        this._depthByLayerId.set(node.id(), depth);
        siblingNodes.push(node);
        nextLayerNodes.push(...node.children());
      }
      currentLayerNodes = nextLayerNodes;
      depth += 5;
    }
    this._maxDepth = depth;
  }

  _depthForLayer(layer: SDK.LayerTreeBase.Layer): number {
    return (this._depthByLayerId.get(layer.id()) || 0) * LayerSpacing;
  }

  _calculateScrollRectDepth(layer: SDK.LayerTreeBase.Layer, index: number): number {
    return this._depthForLayer(layer) + index * ScrollRectSpacing + 1;
  }

  _updateDimensionsForAutoscale(layer: SDK.LayerTreeBase.Layer): void {
    // We don't want to be precise, but rather pick something least affected by
    // animationtransforms, so that we don't change scale too often. So let's
    // disregard transforms, scrolling and relative layer positioning and choose
    // the largest dimensions of all layers.
    if (!this._dimensionsForAutoscale) {
      this._dimensionsForAutoscale = {width: 0, height: 0};
    }

    this._dimensionsForAutoscale.width = Math.max(layer.width(), this._dimensionsForAutoscale.width);
    this._dimensionsForAutoscale.height = Math.max(layer.height(), this._dimensionsForAutoscale.height);
  }

  _calculateLayerRect(layer: SDK.LayerTreeBase.Layer): void {
    if (!this._visibleLayers.has(layer)) {
      return;
    }
    const selection = new LayerSelection(layer);
    const rect = new Rectangle(selection);
    rect.setVertices(layer.quad(), this._depthForLayer(layer));
    this._appendRect(rect);
    this._updateDimensionsForAutoscale(layer);
  }

  _appendRect(rect: Rectangle): void {
    const selection = rect.relatedObject;
    const isSelected = Selection.isEqual(this._lastSelection[OutlineType.Selected], selection);
    const isHovered = Selection.isEqual(this._lastSelection[OutlineType.Hovered], selection);
    if (isSelected) {
      rect.borderColor = SelectedBorderColor;
    } else if (isHovered) {
      rect.borderColor = HoveredBorderColor;
      const fillColor = rect.fillColor || [255, 255, 255, 1];
      const maskColor = HoveredImageMaskColor;
      rect.fillColor = [
        fillColor[0] * maskColor[0] / 255,
        fillColor[1] * maskColor[1] / 255,
        fillColor[2] * maskColor[2] / 255,
        fillColor[3] * maskColor[3],
      ];
    } else {
      rect.borderColor = BorderColor;
    }
    rect.lineWidth = isSelected ? SelectedBorderWidth : BorderWidth;
    this._rects.push(rect);
  }

  _calculateLayerScrollRects(layer: SDK.LayerTreeBase.Layer): void {
    const scrollRects = layer.scrollRects();
    for (let i = 0; i < scrollRects.length; ++i) {
      const selection = new ScrollRectSelection(layer, i);
      const rect = new Rectangle(selection);
      rect.calculateVerticesFromRect(layer, scrollRects[i].rect, this._calculateScrollRectDepth(layer, i));
      rect.fillColor = ScrollRectBackgroundColor;
      this._appendRect(rect);
    }
  }

  _calculateLayerTileRects(layer: SDK.LayerTreeBase.Layer): void {
    const tiles = this._textureManager.tilesForLayer(layer);
    for (let i = 0; i < tiles.length; ++i) {
      const tile = tiles[i];
      if (!tile.texture) {
        continue;
      }
      const selection = new SnapshotSelection(layer, {rect: tile.rect, snapshot: tile.snapshot});
      const rect = new Rectangle(selection);
      if (!this._snapshotLayers.has(layer)) {
        this._snapshotLayers.set(layer, selection);
      }

      rect.calculateVerticesFromRect(layer, tile.rect, this._depthForLayer(layer) + 1);
      rect.texture = tile.texture;
      this._appendRect(rect);
    }
  }

  _calculateRects(): void {
    this._rects = [];
    this._snapshotLayers.clear();
    this._dimensionsForAutoscale = {width: 0, height: 0};
    if (this._layerTree) {
      this._layerTree.forEachLayer(this._calculateLayerRect.bind(this));
    }

    if (this._showSlowScrollRectsSetting && this._showSlowScrollRectsSetting.get() && this._layerTree) {
      this._layerTree.forEachLayer(this._calculateLayerScrollRects.bind(this));
    }

    if (this._layerTexture && this._visibleLayers.has(this._layerTexture.layer)) {
      const layer = this._layerTexture.layer;
      const selection = new LayerSelection(layer);
      const rect = new Rectangle(selection);
      rect.setVertices(layer.quad(), this._depthForLayer(layer));
      rect.texture = this._layerTexture.texture;
      this._appendRect(rect);
    } else if (this._showPaints() && this._layerTree) {
      this._layerTree.forEachLayer(this._calculateLayerTileRects.bind(this));
    }
  }

  _makeColorsArray(color: number[]): number[] {
    let colors: number[] = [];
    const normalizedColor = [color[0] / 255, color[1] / 255, color[2] / 255, color[3]];
    for (let i = 0; i < 4; i++) {
      colors = colors.concat(normalizedColor);
    }
    return colors;
  }

  _setVertexAttribute(attribute: number, array: number[], length: number): void {
    const gl = this._gl;
    if (!gl) {
      return;
    }

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(array), gl.STATIC_DRAW);
    gl.vertexAttribPointer(attribute, length, gl.FLOAT, false, 0, 0);
  }

  _drawRectangle(vertices: number[], mode: number, color?: number[], texture?: Object): void {
    const gl = this._gl;
    const white = [255, 255, 255, 1];
    color = color || white;
    if (!this._shaderProgram) {
      return;
    }

    const vertexPositionAttribute = vertexPositionAttributes.get(this._shaderProgram);
    const textureCoordAttribute = textureCoordAttributes.get(this._shaderProgram);
    const vertexColorAttribute = vertexColorAttributes.get(this._shaderProgram);
    if (typeof vertexPositionAttribute !== 'undefined') {
      this._setVertexAttribute(vertexPositionAttribute, vertices, 3);
    }
    if (typeof textureCoordAttribute !== 'undefined') {
      this._setVertexAttribute(textureCoordAttribute, [0, 1, 1, 1, 1, 0, 0, 0], 2);
    }
    if (typeof vertexColorAttribute !== 'undefined') {
      this._setVertexAttribute(vertexColorAttribute, this._makeColorsArray(color), color.length);
    }

    if (!gl) {
      return;
    }

    const samplerUniform = uniformSamplerLocations.get(this._shaderProgram);
    if (texture) {
      if (samplerUniform) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(samplerUniform, 0);
      }
    } else if (this._whiteTexture) {
      gl.bindTexture(gl.TEXTURE_2D, this._whiteTexture);
    }

    const numberOfVertices = vertices.length / 3;
    gl.drawArrays(mode, 0, numberOfVertices);
  }

  _drawTexture(vertices: number[], texture: WebGLTexture, color?: number[]): void {
    if (!this._gl) {
      return;
    }

    this._drawRectangle(vertices, this._gl.TRIANGLE_FAN, color, texture);
  }

  _drawViewportAndChrome(): void {
    if (!this._layerTree) {
      return;
    }

    const viewport = this._layerTree.viewportSize();
    if (!viewport) {
      return;
    }

    const drawChrome = !Common.Settings.Settings.instance().moduleSetting('frameViewerHideChromeWindow').get() &&
        this._chromeTextures.length >= 3 && this._chromeTextures.indexOf(undefined) < 0;
    const z = (this._maxDepth + 1) * LayerSpacing;
    const borderWidth = Math.ceil(ViewportBorderWidth * this._scale);
    let vertices: number[] = [viewport.width, 0, z, viewport.width, viewport.height, z, 0, viewport.height, z, 0, 0, z];
    if (!this._gl) {
      return;
    }

    this._gl.lineWidth(borderWidth);
    this._drawRectangle(vertices, drawChrome ? this._gl.LINE_STRIP : this._gl.LINE_LOOP, ViewportBorderColor);

    if (!drawChrome) {
      return;
    }

    const viewportSize = this._layerTree.viewportSize();
    if (!viewportSize) {
      return;
    }

    const borderAdjustment = ViewportBorderWidth / 2;
    const viewportWidth = viewportSize.width + 2 * borderAdjustment;
    if (this._chromeTextures[0] && this._chromeTextures[2]) {
      const chromeTextureImage =
          imageForTexture.get(this._chromeTextures[0] as WebGLTexture) || {naturalHeight: 0, naturalWidth: 0};
      const chromeHeight = chromeTextureImage.naturalHeight;

      const middleTextureImage =
          imageForTexture.get(this._chromeTextures[2] as WebGLTexture) || {naturalHeight: 0, naturalWidth: 0};
      const middleFragmentWidth = viewportWidth - chromeTextureImage.naturalWidth - middleTextureImage.naturalWidth;
      let x = -borderAdjustment;
      const y = -chromeHeight;
      for (let i = 0; i < this._chromeTextures.length; ++i) {
        const texture = this._chromeTextures[i];
        if (!texture) {
          continue;
        }

        const image = imageForTexture.get(texture);
        if (!image) {
          continue;
        }
        const width = i === ChromeTexture.Middle ? middleFragmentWidth : image.naturalWidth;
        if (width < 0 || x + width > viewportWidth) {
          break;
        }
        vertices = [x, y, z, x + width, y, z, x + width, y + chromeHeight, z, x, y + chromeHeight, z];
        this._drawTexture(vertices, this._chromeTextures[i] as WebGLTexture);
        x += width;
      }
    }
  }

  _drawViewRect(rect: Rectangle): void {
    if (!this._gl) {
      return;
    }

    const vertices = rect.vertices;
    if (rect.texture) {
      this._drawTexture(vertices, rect.texture, rect.fillColor || undefined);
    } else if (rect.fillColor) {
      this._drawRectangle(vertices, this._gl.TRIANGLE_FAN, rect.fillColor);
    }
    this._gl.lineWidth(rect.lineWidth);
    if (rect.borderColor) {
      this._drawRectangle(vertices, this._gl.LINE_LOOP, rect.borderColor);
    }
  }

  _update(): void {
    if (!this.isShowing()) {
      this._needsUpdate = true;
      return;
    }
    if (!this._layerTree || !this._layerTree.root()) {
      this._failBanner.show(this.contentElement);
      return;
    }
    const gl = this._initGLIfNecessary();
    if (!gl) {
      this._failBanner.element.removeChildren();
      this._failBanner.element.appendChild(this._webglDisabledBanner());
      this._failBanner.show(this.contentElement);
      return;
    }
    this._failBanner.detach();
    const viewportWidth = this._canvasElement.width;
    const viewportHeight = this._canvasElement.height;

    if (!this._depthByLayerId) {
      // Calculate the depth of each graphic only once
      this._calculateDepthsAndVisibility();
    }
    this._calculateRects();
    this._updateTransformAndConstraints();

    gl.viewport(0, 0, viewportWidth, viewportHeight);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this._rects.forEach(this._drawViewRect.bind(this));
    this._drawViewportAndChrome();
  }

  _webglDisabledBanner(): Node {
    const fragment = this.contentElement.ownerDocument.createDocumentFragment();
    fragment.createChild('div').textContent = i18nString(UIStrings.cantDisplayLayers);
    fragment.createChild('div').textContent = i18nString(UIStrings.webglSupportIsDisabledInYour);
    fragment.appendChild(i18n.i18n.getFormatLocalizedString(
        str_, UIStrings.checkSForPossibleReasons, {PH1: UI.XLink.XLink.create('about:gpu')}));
    return fragment;
  }

  _selectionFromEventPoint(event: Event): Selection|null {
    const mouseEvent = event as MouseEvent;
    if (!this._layerTree) {
      return null;
    }
    let closestIntersectionPoint: number = Infinity;
    let closestObject: Selection|null = null;
    const projectionMatrix =
        new WebKitCSSMatrix().scale(1, -1, -1).translate(-1, -1, 0).multiply(this._projectionMatrix);
    const x0 = (mouseEvent.clientX - this._canvasElement.totalOffsetLeft()) * window.devicePixelRatio;
    const y0 = -(mouseEvent.clientY - this._canvasElement.totalOffsetTop()) * window.devicePixelRatio;

    function checkIntersection(rect: Rectangle): void {
      if (!rect.relatedObject) {
        return;
      }
      const t = rect.intersectWithLine(projectionMatrix, x0, y0);
      if (t && t < closestIntersectionPoint) {
        closestIntersectionPoint = t;
        closestObject = rect.relatedObject;
      }
    }

    this._rects.forEach(checkIntersection);
    return closestObject;
  }

  _createVisibilitySetting(caption: string, name: string, value: boolean, toolbar: UI.Toolbar.Toolbar):
      Common.Settings.Setting<boolean> {
    const setting = Common.Settings.Settings.instance().createSetting(name, value);
    setting.setTitle(i18nString(caption));
    setting.addChangeListener(this._update, this);
    toolbar.appendToolbarItem(new UI.Toolbar.ToolbarSettingCheckbox(setting));
    return setting;
  }

  _initToolbar(): void {
    this._panelToolbar = this._transformController.toolbar();
    this.contentElement.appendChild(this._panelToolbar.element);
    this._showSlowScrollRectsSetting = this._createVisibilitySetting(
        i18nString(UIStrings.slowScrollRects), 'frameViewerShowSlowScrollRects', true, this._panelToolbar);
    this._showPaintsSetting =
        this._createVisibilitySetting(i18nString(UIStrings.paints), 'frameViewerShowPaints', true, this._panelToolbar);
    this._showPaintsSetting.addChangeListener(this._updatePaints, this);
    Common.Settings.Settings.instance()
        .moduleSetting('frameViewerHideChromeWindow')
        .addChangeListener(this._update, this);
  }

  _onContextMenu(event: Event): void {
    const contextMenu = new UI.ContextMenu.ContextMenu(event);
    contextMenu.defaultSection().appendItem(
        i18nString(UIStrings.resetView), () => this._transformController.resetAndNotify(), false);
    const selection = this._selectionFromEventPoint(event);
    if (selection && selection.type() === Type.Snapshot) {
      contextMenu.defaultSection().appendItem(
          i18nString(UIStrings.showPaintProfiler),
          this.dispatchEventToListeners.bind(this, Events.PaintProfilerRequested, selection), false);
    }
    this._layerViewHost.showContextMenu(contextMenu, selection);
  }

  _onMouseMove(event: Event): void {
    const mouseEvent = event as MouseEvent;
    if (mouseEvent.which) {
      return;
    }
    this._layerViewHost.hoverObject(this._selectionFromEventPoint(event));
  }

  _onMouseDown(event: Event): void {
    const mouseEvent = event as MouseEvent;
    this._mouseDownX = mouseEvent.clientX;
    this._mouseDownY = mouseEvent.clientY;
  }

  _onMouseUp(event: Event): void {
    const mouseEvent = event as MouseEvent;
    const maxDistanceInPixels = 6;
    if (this._mouseDownX && Math.abs(mouseEvent.clientX - this._mouseDownX) < maxDistanceInPixels &&
        Math.abs(mouseEvent.clientY - (this._mouseDownY || 0)) < maxDistanceInPixels) {
      this._canvasElement.focus();
      this._layerViewHost.selectObject(this._selectionFromEventPoint(event));
    }
    delete this._mouseDownX;
    delete this._mouseDownY;
  }

  _onDoubleClick(event: Event): void {
    const selection = this._selectionFromEventPoint(event);
    if (selection && (selection.type() === Type.Snapshot || selection.layer())) {
      this.dispatchEventToListeners(Events.PaintProfilerRequested, selection);
    }
    event.stopPropagation();
  }

  _updatePaints(): void {
    if (this._showPaints()) {
      this._textureManager.setLayerTree(this._layerTree);
      this._textureManager.forceUpdate();
    } else {
      this._textureManager.reset();
    }
    this._update();
  }

  _showPaints(): boolean {
    return this._showPaintsSetting ? this._showPaintsSetting.get() : false;
  }
}

// TODO(crbug.com/1167717): Make this a const enum again
// eslint-disable-next-line rulesdir/const_enum
export enum OutlineType {
  Hovered = 'hovered',
  Selected = 'selected',
}

// TODO(crbug.com/1167717): Make this a const enum again
// eslint-disable-next-line rulesdir/const_enum
export enum Events {
  PaintProfilerRequested = 'PaintProfilerRequested',
  ScaleChanged = 'ScaleChanged',
}

export const enum ChromeTexture {
  Left = 0,
  Middle = 1,
  Right = 2,
}

export const FragmentShader = '' +
    'precision mediump float;\n' +
    'varying vec4 vColor;\n' +
    'varying vec2 vTextureCoord;\n' +
    'uniform sampler2D uSampler;\n' +
    'void main(void)\n' +
    '{\n' +
    '    gl_FragColor = texture2D(uSampler, vec2(vTextureCoord.s, vTextureCoord.t)) * vColor;\n' +
    '}';

export const VertexShader = '' +
    'attribute vec3 aVertexPosition;\n' +
    'attribute vec2 aTextureCoord;\n' +
    'attribute vec4 aVertexColor;\n' +
    'uniform mat4 uPMatrix;\n' +
    'varying vec2 vTextureCoord;\n' +
    'varying vec4 vColor;\n' +
    'void main(void)\n' +
    '{\n' +
    'gl_Position = uPMatrix * vec4(aVertexPosition, 1.0);\n' +
    'vColor = aVertexColor;\n' +
    'vTextureCoord = aTextureCoord;\n' +
    '}';

export const HoveredBorderColor = [0, 0, 255, 1];
export const SelectedBorderColor = [0, 255, 0, 1];
export const BorderColor = [0, 0, 0, 1];
export const ViewportBorderColor = [160, 160, 160, 1];
export const ScrollRectBackgroundColor = [178, 100, 100, 0.6];
export const HoveredImageMaskColor = [200, 200, 255, 1];
export const BorderWidth = 1;
export const SelectedBorderWidth = 2;
export const ViewportBorderWidth = 3;

export const LayerSpacing = 20;
export const ScrollRectSpacing = 4;

export class LayerTextureManager {
  _textureUpdatedCallback: () => void;
  _throttler: Common.Throttler.Throttler;
  _scale: number;
  _active: boolean;
  _queue!: SDK.LayerTreeBase.Layer[];
  _tilesByLayer!: Map<SDK.LayerTreeBase.Layer, Tile[]>;
  _gl?: WebGLRenderingContext;
  constructor(textureUpdatedCallback: () => void) {
    this._textureUpdatedCallback = textureUpdatedCallback;
    this._throttler = new Common.Throttler.Throttler(0);
    this._scale = 0;
    this._active = false;
    this.reset();
  }

  static _createTextureForImage(gl: WebGLRenderingContext|null, image: HTMLImageElement): WebGLTexture {
    if (!gl) {
      throw new Error('WebGLRenderingContext not provided');
    }
    const texture = gl.createTexture();
    if (!texture) {
      throw new Error('Unable to create texture');
    }

    imageForTexture.set(texture, image);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }

  reset(): void {
    if (this._tilesByLayer) {
      this.setLayerTree(null);
    }

    /** @type {!Map<!SDK.LayerTreeBase.Layer, !Array<!Tile>>} */
    this._tilesByLayer = new Map();
    /** @type {!Array<!SDK.LayerTreeBase.Layer>} */
    this._queue = [];
  }

  setContext(glContext: WebGLRenderingContext): void {
    this._gl = glContext;
    if (this._scale) {
      this._updateTextures();
    }
  }

  suspend(): void {
    this._active = false;
  }

  resume(): void {
    this._active = true;
    if (this._queue.length) {
      this._update();
    }
  }

  setLayerTree(layerTree: SDK.LayerTreeBase.LayerTreeBase|null): void {
    const newLayers = new Set<SDK.LayerTreeBase.Layer>();
    const oldLayers = Array.from(this._tilesByLayer.keys());
    if (layerTree) {
      layerTree.forEachLayer(layer => {
        if (!layer.drawsContent()) {
          return;
        }
        newLayers.add(layer);
        if (!this._tilesByLayer.has(layer)) {
          this._tilesByLayer.set(layer, []);
          this.layerNeedsUpdate(layer);
        }
      });
    }
    if (!oldLayers.length) {
      this.forceUpdate();
    }
    for (const layer of oldLayers) {
      if (newLayers.has(layer)) {
        continue;
      }
      const tiles = this._tilesByLayer.get(layer);
      if (tiles) {
        tiles.forEach(tile => tile.dispose());
      }
      this._tilesByLayer.delete(layer);
    }
  }

  _setSnapshotsForLayer(layer: SDK.LayerTreeBase.Layer, snapshots: SDK.PaintProfiler.SnapshotWithRect[]):
      Promise<void> {
    const oldSnapshotsToTiles = new Map((this._tilesByLayer.get(layer) || []).map(tile => [tile.snapshot, tile]));
    const newTiles = [];
    const reusedTiles = [];
    for (const snapshot of snapshots) {
      const oldTile = oldSnapshotsToTiles.get(snapshot.snapshot);
      if (oldTile) {
        reusedTiles.push(oldTile);
        oldSnapshotsToTiles.delete(snapshot.snapshot);
      } else {
        newTiles.push(new Tile(snapshot));
      }
    }
    this._tilesByLayer.set(layer, reusedTiles.concat(newTiles));
    for (const tile of oldSnapshotsToTiles.values()) {
      tile.dispose();
    }
    const gl = this._gl;
    if (!gl || !this._scale) {
      return Promise.resolve();
    }
    return Promise.all(newTiles.map(tile => tile.update(gl, this._scale))).then(this._textureUpdatedCallback);
  }

  setScale(scale: number): void {
    if (this._scale && this._scale >= scale) {
      return;
    }
    this._scale = scale;
    this._updateTextures();
  }

  tilesForLayer(layer: SDK.LayerTreeBase.Layer): Tile[] {
    return this._tilesByLayer.get(layer) || [];
  }

  layerNeedsUpdate(layer: SDK.LayerTreeBase.Layer): void {
    if (this._queue.indexOf(layer) < 0) {
      this._queue.push(layer);
    }
    if (this._active) {
      this._throttler.schedule(this._update.bind(this));
    }
  }

  forceUpdate(): void {
    this._queue.forEach(layer => this._updateLayer(layer));
    this._queue = [];
    this._update();
  }

  _update(): Promise<void> {
    const layer = this._queue.shift();
    if (!layer) {
      return Promise.resolve();
    }
    if (this._queue.length) {
      this._throttler.schedule(this._update.bind(this));
    }
    return this._updateLayer(layer);
  }

  _updateLayer(layer: SDK.LayerTreeBase.Layer): Promise<void> {
    return Promise.all(layer.snapshots())
        .then(
            snapshots => this._setSnapshotsForLayer(
                layer, snapshots.filter(snapshot => snapshot !== null) as SDK.PaintProfiler.SnapshotWithRect[]));
  }

  _updateTextures(): void {
    if (!this._gl) {
      return;
    }
    if (!this._scale) {
      return;
    }

    for (const tiles of this._tilesByLayer.values()) {
      for (const tile of tiles) {
        const promise = tile.updateScale(this._gl, this._scale);
        if (promise) {
          promise.then(this._textureUpdatedCallback);
        }
      }
    }
  }
}

export class Rectangle {
  relatedObject: Selection|null;
  lineWidth: number;
  borderColor: number[]|null;
  fillColor: number[]|null;
  texture: WebGLTexture|null;
  vertices!: number[];
  constructor(relatedObject: Selection|null) {
    this.relatedObject = relatedObject;
    this.lineWidth = 1;
    this.borderColor = null;
    this.fillColor = null;
    this.texture = null;
  }

  setVertices(quad: number[], z: number): void {
    this.vertices = [quad[0], quad[1], z, quad[2], quad[3], z, quad[4], quad[5], z, quad[6], quad[7], z];
  }

  /**
   * Finds coordinates of point on layer quad, having offsets (ratioX * width) and (ratioY * height)
   * from the left corner of the initial layer rect, where width and heigth are layer bounds.
   */
  _calculatePointOnQuad(quad: number[], ratioX: number, ratioY: number): number[] {
    const x0 = quad[0];
    const y0 = quad[1];
    const x1 = quad[2];
    const y1 = quad[3];
    const x2 = quad[4];
    const y2 = quad[5];
    const x3 = quad[6];
    const y3 = quad[7];
    // Point on the first quad side clockwise
    const firstSidePointX = x0 + ratioX * (x1 - x0);
    const firstSidePointY = y0 + ratioX * (y1 - y0);
    // Point on the third quad side clockwise
    const thirdSidePointX = x3 + ratioX * (x2 - x3);
    const thirdSidePointY = y3 + ratioX * (y2 - y3);
    const x = firstSidePointX + ratioY * (thirdSidePointX - firstSidePointX);
    const y = firstSidePointY + ratioY * (thirdSidePointY - firstSidePointY);
    return [x, y];
  }

  calculateVerticesFromRect(layer: SDK.LayerTreeBase.Layer, rect: Protocol.DOM.Rect, z: number): void {
    const quad = layer.quad();
    const rx1 = rect.x / layer.width();
    const rx2 = (rect.x + rect.width) / layer.width();
    const ry1 = rect.y / layer.height();
    const ry2 = (rect.y + rect.height) / layer.height();
    const rectQuad = this._calculatePointOnQuad(quad, rx1, ry1)
                         .concat(this._calculatePointOnQuad(quad, rx2, ry1))
                         .concat(this._calculatePointOnQuad(quad, rx2, ry2))
                         .concat(this._calculatePointOnQuad(quad, rx1, ry2));
    this.setVertices(rectQuad, z);
  }

  /**
   * Intersects quad with given transform matrix and line l(t) = (x0, y0, t)
   */
  intersectWithLine(matrix: DOMMatrix, x0: number, y0: number): number|undefined {
    let i;
    // Vertices of the quad with transform matrix applied
    const points = [];
    for (i = 0; i < 4; ++i) {
      points[i] = UI.Geometry.multiplyVectorByMatrixAndNormalize(
          new UI.Geometry.Vector(this.vertices[i * 3], this.vertices[i * 3 + 1], this.vertices[i * 3 + 2]), matrix);
    }
    // Calculating quad plane normal
    const normal = UI.Geometry.crossProduct(
        UI.Geometry.subtract(points[1], points[0]), UI.Geometry.subtract(points[2], points[1]));
    // General form of the equation of the quad plane: A * x + B * y + C * z + D = 0
    const A = normal.x;
    const B = normal.y;
    const C = normal.z;
    const D = -(A * points[0].x + B * points[0].y + C * points[0].z);
    // Finding t from the equation
    const t = -(D + A * x0 + B * y0) / C;
    // Point of the intersection
    const pt = new UI.Geometry.Vector(x0, y0, t);
    // Vectors from the intersection point to vertices of the quad
    const tVects = points.map(UI.Geometry.subtract.bind(null, pt));
    // Intersection point lies inside of the polygon if scalar products of normal of the plane and
    // cross products of successive tVects are all nonstrictly above or all nonstrictly below zero
    for (i = 0; i < tVects.length; ++i) {
      const product =
          UI.Geometry.scalarProduct(normal, UI.Geometry.crossProduct(tVects[i], tVects[(i + 1) % tVects.length]));
      if (product < 0) {
        return undefined;
      }
    }
    return t;
  }
}

export class Tile {
  snapshot: SDK.PaintProfiler.PaintProfilerSnapshot;
  rect: Protocol.DOM.Rect;
  scale: number;
  texture: WebGLTexture|null;
  _gl!: WebGLRenderingContext;
  constructor(snapshotWithRect: SDK.PaintProfiler.SnapshotWithRect) {
    this.snapshot = snapshotWithRect.snapshot;
    this.rect = snapshotWithRect.rect;
    this.scale = 0;
    this.texture = null;
  }

  dispose(): void {
    this.snapshot.release();
    if (this.texture) {
      this._gl.deleteTexture(this.texture);
      this.texture = null;
    }
  }

  updateScale(glContext: WebGLRenderingContext, scale: number): Promise<void>|null {
    if (this.texture && this.scale >= scale) {
      return null;
    }
    return this.update(glContext, scale);
  }

  async update(glContext: WebGLRenderingContext, scale: number): Promise<void> {
    this._gl = glContext;
    this.scale = scale;
    const imageURL = await this.snapshot.replay(scale);
    const image = imageURL ? await UI.UIUtils.loadImage(imageURL) : null;
    this.texture = image ? LayerTextureManager._createTextureForImage(glContext, image) : null;
  }
}
