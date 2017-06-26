import {
    join,
    requestAnimFrame,
    emptyImageUrl
} from 'core/util';
import * as mat4 from 'core/util/mat4';
import {
    on,
    createEl,
    setTransformMatrix,
    removeTransform,
    removeDomNode,
    setOpacity,
    TRANSFORM,
    TRANSITION,
    CSSFILTER
} from 'core/util/dom';
import Class from 'core/Class';
import Browser from 'core/Browser';
import Point from 'geo/Point';
import TileLayer from 'layer/tile/TileLayer';


const POSITION0 = 'position:absolute;';

/**
 * @classdesc
 * A renderer based on HTML Doms for TileLayers.
 * It is implemented based on Leaflet's GridLayer.
 * @class
 * @protected
 * @memberOf tilelayer
 * @name Dom
 * @extends {Class}
 * @param {TileLayer} layer - layer of the renderer
 */
export default class TileLayerDomRenderer extends Class {

    constructor(layer) {
        super();
        this.layer = layer;
        this._tiles = {};
    }

    getMap() {
        if (!this.layer) {
            return null;
        }
        return this.layer.getMap();
    }

    show() {
        if (this._container) {
            this.render();
            this._show();
        }
    }

    hide() {
        if (this._container) {
            this._hide();
            this.clear();
        }
    }

    remove() {
        delete this._tiles;
        delete this.layer;
        this._clearCameraCache();
        this._removeLayerContainer();
    }

    clear() {
        this._removeAllTiles();
        this._clearLayerContainer();
    }

    setZIndex(z) {
        this._zIndex = z;
        if (this._container) {
            this._container.style.zIndex = z;
        }
    }

    prepareRender() {
    }

    render() {
        this._renderTiles();
    }

    drawOnInteracting() {
        const map = this.getMap();
        if (!map) {
            return;
        }
        if (map.isZooming()) {
            this._drawOnZooming();
        } else if (map.isDragRotating()) {
            this._drawOnDragRotating();
        } else if (map.isMoving()) {
            this._drawOnMoving();
        }

    }

    _drawOnZooming() {
        if (!this._zoomParam) {
            return;
        }
        const map = this.getMap();
        const param = this._zoomParam;
        const zoom = this._tileZoom;
        if (this._levelContainers && this._levelContainers[zoom]) {
            if (map.domCssMatrix) {
                this._prepareTileContainer();
            } else {
                const matrix = param.matrix['view'];
                setTransformMatrix(this._levelContainers[zoom], matrix);
            }
        }
        delete this._zoomParam;
    }

    _drawOnMoving() {
        const map = this.getMap();
        // prevent render when zooming or dragrotating, which may crash the browser
        if (!map || !map.getPitch() && !this.layer.options['renderOnMoving']) {
            return;
        }
        this.render();
    }

    _drawOnDragRotating() {
        // when rotation is canceled, tiles needs to be repositioned.
        const mat = this.getMap().domCssMatrix;
        if (!mat) {
            this._renderTiles();
        } else {
            this._prepareTileContainer();
        }
    }

    _renderTiles() {
        if (!this._container) {
            this._createLayerContainer();
        }
        const tileGrid = this.layer._getTiles();
        if (!tileGrid) {
            return;
        }

        const queue = this._getTileQueue(tileGrid);

        this._tileZoom = tileGrid['zoom'];

        this._prepareTileContainer();

        if (queue.length > 0) {
            const container = this._getTileContainer(tileGrid['zoom']);
            const fragment = document.createDocumentFragment();
            for (let i = 0, l = queue.length; i < l; i++) {
                fragment.appendChild(this._loadTile(queue[i]));
            }
            container.tile.appendChild(fragment);
        }
        this._updateTileSize();
        if (queue.length === 0) {
            this.layer.fire('layerload');
        }
    }

    _getTileQueue(tileGrid) {
        const map = this.getMap(),
            tiles = tileGrid['tiles'],
            queue = [];
        const mat = map.domCssMatrix;

        const preCamOffset = this._camOffset;
        if (!this._camOffset || (!mat && !this._camOffset.isZero())) {
            // offset of tile container due to camera matrix
            this._camOffset = new Point(0, 0);
        }

        if (this._preCenterId && mat) {
            // caculate tile container's offset if map is pitching
            const preCenterTilePos = this._tiles[this._preCenterId]['viewPoint'];
            let current;
            for (let i = tiles.length - 1; i >= 0; i--) {
                if (tiles[i]['id'] === this._preCenterId) {
                    current = tiles[i]['viewPoint'];
                    break;
                }
            }
            if (current) {
                const offset = current.sub(preCenterTilePos);
                this._camOffset._add(offset);
            }
        }

        if (this._tiles) {
            // when camera is canceled, all current tiles needs to be repositioned (adding pre camera offset)
            const repos = !mat && preCamOffset && !preCamOffset.isZero();
            for (const p in this._tiles) {
                const t = this._tiles[p];
                this._tiles[p].current = false;
                if (repos) {
                    const pos = t['pos'];
                    pos._add(preCamOffset);
                    this._posTileImage(t['el'], pos);
                    t['viewPoint'] = pos;
                }
            }
        }

        for (let i = tiles.length - 1; i >= 0; i--) {
            const cachedTile = this._tiles[tiles[i]['id']];
            if (cachedTile) {
                //tile is already added
                cachedTile.current = true;
                if (mat) {
                    // has camera matrix, update viewPoint of all the existing tiles.
                    // tile doesn't need to be repositioned, but view point needs to be updated to caculate camera offset.
                    cachedTile['viewPoint'] = tiles[i]['viewPoint'];
                }
                if (this._reposTiles) {
                    // existing tiles need to be repositioned to tileGrid's new viewPoint.
                    const pos = tiles[i]['viewPoint'];
                    cachedTile['viewPoint'] = pos;
                    this._posTileImage(cachedTile['el'], pos);
                }
                continue;
            }
            tiles[i].current = true;
            if (mat && this._camOffset) {
                tiles[i]['viewPoint']._sub(this._camOffset);
            }
            queue.push(tiles[i]);
        }
        this._reposTiles = false;
        this._preCenterId = tileGrid['center'];
        return queue;
    }


    /**
     * Update container's transform style in the following cases :
     * 1 at an integer zoom
     * 2 at a fractional zoom
     * 3 with domCssMatrix(pitch/bearing) at an integer zoom
     * 4 with domCssMatrix(pitch/bearing) at a fractional zoom
     * @private
     */
    _prepareTileContainer() {
        const map = this.getMap(),
            cssMat = map.domCssMatrix,
            container = this._getTileContainer(this._tileZoom),
            size = map.getSize(),
            zoomFraction = map._getResolution(this._tileZoom) / map._getResolution();
        if (container.style.left) {
            // Remove container's left/top if it has.
            // Left, top is set in onZoomEnd to keep container's position when map platform's offset is reset to 0.
            container.style.left = null;
            container.style.top = null;
        }
        if (cssMat) {
            if (parseInt(container.style.width) !== size['width'] || parseInt(container.style.height) !== size['height']) {
                container.style.width = size['width'] + 'px';
                container.style.height = size['height'] + 'px';
            }
            let matrix;
            if (zoomFraction !== 1) {
                const m = mat4.create();

                // // when origin is not in the center with pitch, layer scaling is not fit for map's scaling, add a matOffset to fix.
                // const pitch = map.getPitch();
                // const matOffset = [
                //     (origin.x - size['width'] / 2)  * (1 - zoomFraction),
                //     //FIXME Math.cos(pitch * Math.PI / 180) is just a magic num, works when tilting but may have problem when rotating
                //     (origin.y - size['height'] / 2) * (1 - zoomFraction) * (pitch ? Math.cos(pitch * Math.PI / 180) : 1),
                //     0
                // ];
                // mat4.translate(m, m, matOffset);

                // Fractional zoom, multiply current domCssMat with zoomFraction
                mat4.multiply(m, m, cssMat);
                mat4.scale(m, m, [zoomFraction, zoomFraction, 1]);
                matrix = join(m);
            } else {
                matrix = join(cssMat);
            }
            const mapOffset = map.offsetPlatform().round();
            if (!map.isZooming()) {
                // When map is zooming, tile's position is same with positions when zooming starts, so does't need to refresh camOffsets.
                container.tile.style[TRANSFORM] = 'translate3d(' + (this._camOffset.x + mapOffset.x / zoomFraction) + 'px, ' + (this._camOffset.y + mapOffset.y / zoomFraction) + 'px, 0px)';
            }

            container.style[TRANSFORM] = 'translate3d(' + (-mapOffset.x) + 'px, ' + (-mapOffset.y) + 'px, 0px) matrix3D(' + matrix + ')';
        } else {
            this._resetDomCssMatrix();
            if (zoomFraction !== 1) {
                // fractional zoom
                const matrix = [zoomFraction, 0, 0, zoomFraction, size['width'] / 2 *  (1 - zoomFraction), size['height'] / 2 *  (1 - zoomFraction)];
                setTransformMatrix(container.tile, matrix);
            } else {
                removeTransform(container.tile);
            }
        }
    }

    _resetDomCssMatrix() {
        const container = this._getTileContainer(this._tileZoom);
        removeTransform(container);
        if (container.style.width || container.style.height) {
            container.style.width = null;
            container.style.height = null;
        }
    }

    _getTileSize() {
        const size = this.layer.getTileSize();
        const tileSize = [size['width'], size['height']];
        const map = this.getMap();
        // A workround to fix seams between tiles when transforming tile container.
        // Should be a webkit's bug:
        // https://bugs.chromium.org/p/chromium/issues/detail?id=600120
        // related issue by Leaflet:
        // https://github.com/Leaflet/Leaflet/issues/3575
        if (Browser.webkit && (map.isTransforming() || map.isZooming() || map.getZoom() !== this._tileZoom)) {
            tileSize[0]++;
            tileSize[1]++;
        }
        return tileSize;
    }

    /**
     * update tile images' size
     */
    _updateTileSize() {
        if (this._tiles) {
            const zooming = this.getMap().isZooming();
            const size = this._getTileSize();
            for (const p in this._tiles) {
                if (this._tiles[p].current) {
                    if (size[0] !== this._tiles[p]['size'][0]) {
                        this._tiles[p]['size'] = size;
                        const img = this._tiles[p]['el'];
                        if (img) {
                            img.width = size[0];
                            img.height = size[1];
                        }
                        if (zooming) {
                            img.style[TRANSITION] = null;
                        }
                    } else {
                        break;
                    }
                }
            }
        }
    }

    _loadTile(tile) {
        this._tiles[tile['id']] = tile;
        return this._createTile(tile, this._tileReady.bind(this));
    }

    _createTile(tile, done) {
        const tileSize = this._getTileSize();
        const w = tileSize[0],
            h = tileSize[1];

        const tileImage = createEl('img');
        tile['el'] = tileImage;
        tile['size'] = tileSize;
        tile['pos'] = tile['viewPoint'];

        on(tileImage, 'load', this._tileOnLoad.bind(this, done, tile));
        on(tileImage, 'error', this._tileOnError.bind(this, done, tile));

        if (this.layer.options['crossOrigin']) {
            tile.crossOrigin = this.layer.options['crossOrigin'];
        }

        tileImage.style.position = 'absolute';
        this._posTileImage(tileImage, tile['viewPoint']);

        tileImage.alt = '';
        tileImage.width = w;
        tileImage.height = h;

        setOpacity(tileImage, 0);

        if (this.layer.options['cssFilter']) {
            tileImage.style[CSSFILTER] = this.layer.options['cssFilter'];
        }

        tileImage.src = tile['url'];

        return tileImage;
    }

    _tileReady(err, tile) {
        if (!this.layer) {
            return;
        }
        if (err) {
            /**
             * tileerror event, fired when layer is 'dom' rendered and a tile errors
             *
             * @event TileLayer#tileerror
             * @type {Object}
             * @property {String} type - tileerror
             * @property {TileLayer} target - tile layer
             * @property {String} err  - error message
             * @property {Object} tile - tile
             */
            this.layer.fire('tileerror', {
                error: err,
                tile: tile
            });
        }

        tile.loaded = Date.now();

        const map = this.getMap();

        if (this._fadeAnimated) {
            tile['el'].style[TRANSITION] = 'opacity 250ms';
        }

        setOpacity(tile['el'], 1);
        tile.active = true;

        /**
         * tileload event, fired when layer is 'dom' rendered and a tile is loaded
         *
         * @event TileLayer#tileload
         * @type {Object}
         * @property {String} type - tileload
         * @property {TileLayer} target - tile layer
         * @property {Object} tile - tile
         */
        this.layer.fire('tileload', {
            tile: tile
        });

        if (this._noTilesToLoad()) {
            this.layer.fire('layerload');

            if (Browser.ielt9) {
                requestAnimFrame(this._pruneTiles, this);
            } else {
                if (this._pruneTimeout) {
                    clearTimeout(this._pruneTimeout);
                }
                const timeout = map ? map.options['zoomAnimationDuration'] : 250,
                    pruneLevels = (map && this.layer === map.getBaseLayer()) ? !map.options['zoomBackground'] : true;
                // Wait a bit more than 0.2 secs (the duration of the tile fade-in)
                // to trigger a pruning.
                this._pruneTimeout = setTimeout(this._pruneTiles.bind(this, pruneLevels), timeout + 100);
            }
        }
    }

    _tileOnLoad(done, tile) {
        // For https://github.com/Leaflet/Leaflet/issues/3332
        if (Browser.ielt9) {
            setTimeout(done.bind(this, null, tile), 0);
        } else {
            done.call(this, null, tile);
        }
    }

    _tileOnError(done, tile) {
        if (!this.layer) {
            return;
        }
        const errorUrl = this.layer.options['errorTileUrl'];
        if (errorUrl) {
            tile['el'].src = errorUrl;
        } else {
            tile['el'].style.display = 'none';
        }
        done.call(this, 'error', tile);
    }

    _noTilesToLoad() {
        for (const key in this._tiles) {
            if (!this._tiles[key].loaded) {
                return false;
            }
        }
        return true;
    }

    _pruneTiles(pruneLevels = true) {
        const map = this.getMap();
        if (!map || map.isMoving()) {
            return;
        }
        this._abortLoading();

        const zoom = this._tileZoom;

        if (!this.layer.isVisible()) {
            this._removeAllTiles();
            return;
        }

        for (const key in this._tiles) {
            if (this._tiles[key]['z'] === zoom && !this._tiles[key].current) {
                this._removeTile(key);
            }
        }

        if (pruneLevels) {
            for (const key in this._tiles) {
                if (this._tiles[key]['z'] !== zoom) {
                    this._removeTile(key);
                }
            }
            for (const z in this._levelContainers) {
                if (+z !== zoom) {
                    removeDomNode(this._levelContainers[z]);
                    this._removeTilesAtZoom(z);
                    delete this._levelContainers[z];
                }
            }
        }

    }

    _removeTile(key) {
        const tile = this._tiles[key];
        if (!tile) {
            return;
        }

        removeDomNode(tile.el);

        delete this._tiles[key];

        /**
         * tileunload event, fired when layer is 'dom' rendered and a tile is removed
         *
         * @event TileLayer#tileunload
         * @type {Object}
         * @property {String} type - tileunload
         * @property {TileLayer} target - tile layer
         * @property {Object} tile - tile
         */
        this.layer.fire('tileunload', {
            tile: tile
        });
    }

    _removeTilesAtZoom(zoom) {
        for (const key in this._tiles) {
            if (+this._tiles[key]['z'] !== +zoom) {
                continue;
            }
            this._removeTile(key);
        }
    }

    _removeAllTiles() {
        for (const key in this._tiles) {
            this._removeTile(key);
        }
    }

    _getTileContainer(zoom) {
        if (!this._levelContainers) {
            this._levelContainers = {};
        }
        if (!this._levelContainers[zoom]) {
            const container = this._levelContainers[zoom] = createEl('div', 'maptalks-tilelayer-level');
            container.style.cssText = POSITION0;

            const tileContainer =  createEl('div');
            tileContainer.style.cssText = POSITION0;
            tileContainer.style.willChange = 'transform';
            container.appendChild(tileContainer);
            container.tile = tileContainer;
            this._container.appendChild(container);
        }
        return this._levelContainers[zoom];
    }

    _createLayerContainer() {
        const container = this._container = createEl('div', 'maptalks-tilelayer');
        container.style.cssText = POSITION0;
        if (this._zIndex) {
            container.style.zIndex = this._zIndex;
        }
        const parentContainer = this.layer.options['container'] === 'front' ? this.getMap()._panels['frontLayer'] : this.getMap()._panels['backLayer'];
        parentContainer.appendChild(container);
    }

    _clearLayerContainer() {
        if (this._container) {
            this._container.innerHTML = '';
        }
        delete this._levelContainers;
    }

    _removeLayerContainer() {
        if (this._container) {
            removeDomNode(this._container);
        }
        delete this._container;
        delete this._levelContainers;
    }

    getEvents() {
        const events = {
            '_zoomstart'    : this.onZoomStart,
            //prune tiles before drag rotating to reduce tiles when rotating
            '_touchzoomstart _dragrotatestart' : this._pruneTiles,
            '_zooming'      : this.onZooming,
            '_zoomend'      : this.onZoomEnd,
            '_dragrotateend' : this.render
        };
        return events;
    }

    _canTransform() {
        return Browser.any3d || Browser.ie9;
    }

    _show() {
        this._container.style.display = '';
    }

    _hide() {
        this._container.style.display = 'none';
    }

    _posTileImage(tileImage, pos) {
        if (Browser.any3d) {
            tileImage.style[TRANSFORM] = 'translate3d(' + pos.x + 'px, ' + pos.y + 'px, 0px)';
        } else {
            tileImage.style[TRANSFORM] = 'translate(' + pos.x + 'px, ' + pos.y + 'px)';
        }
    }

    onZoomStart() {
        this._fadeAnimated = false;
        this._mapOffset = this.getMap().offsetPlatform().round();
        if (!this._canTransform()) {
            this._hide();
        }
        this._pruneTiles();
        this._updateTileSize();
    }

    onZooming(param) {
        this._zoomParam = param;
    }

    onZoomEnd(param) {
        delete this._zoomParam;
        if (this._pruneTimeout) {
            clearTimeout(this._pruneTimeout);
        }
        this._clearCameraCache();
        this._reposTiles = (param['to'] === this._tileZoom);
        if (this._levelContainers) {
            const container = this._levelContainers[this._tileZoom];
            if (this._canTransform()) {
                if (container && this._mapOffset) {
                    // Container at old _tileZoom becomes background of new zoom container.
                    // When zooming ends, map's platform offset will be reset to 0,
                    // thus old container's left and top will be set with map's platform offset when zooming starts to force old container staying in the right position.
                    container.style.left = this._mapOffset.x + 'px';
                    container.style.top = this._mapOffset.y + 'px';
                }
            } else {
                if (container) {
                    container.style.display = 'none';
                }
                this._show();
            }
        }
        this._fadeAnimated = !Browser.mobile && true;
    }

    _clearCameraCache() {
        delete this._preCenterId;
        delete this._camOffset;
    }

    _abortLoading() {
        const falseFn = function () { return false; };
        for (const i in this._tiles) {
            if (this._tiles[i].z !== this._tileZoom || !this._tiles[i].current) {
                const tile = this._tiles[i].el;

                tile.onload = falseFn;
                tile.onerror = falseFn;

                if (!tile.loaded) {
                    tile.src = emptyImageUrl;
                    removeDomNode(tile);
                }
            }
        }
    }
}

TileLayer.registerRenderer('dom', TileLayerDomRenderer);
