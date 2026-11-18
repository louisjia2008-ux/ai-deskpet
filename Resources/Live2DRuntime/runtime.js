"use strict";
(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });
  var __commonJS = (cb, mod) => function __require2() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));

  // node_modules/eventemitter3/index.js
  var require_eventemitter3 = __commonJS({
    "node_modules/eventemitter3/index.js"(exports, module) {
      "use strict";
      var has = Object.prototype.hasOwnProperty;
      var prefix = "~";
      function Events() {
      }
      if (Object.create) {
        Events.prototype = /* @__PURE__ */ Object.create(null);
        if (!new Events().__proto__) prefix = false;
      }
      function EE(fn, context2, once) {
        this.fn = fn;
        this.context = context2;
        this.once = once || false;
      }
      function addListener(emitter, event, fn, context2, once) {
        if (typeof fn !== "function") {
          throw new TypeError("The listener must be a function");
        }
        var listener = new EE(fn, context2 || emitter, once), evt = prefix ? prefix + event : event;
        if (!emitter._events[evt]) emitter._events[evt] = listener, emitter._eventsCount++;
        else if (!emitter._events[evt].fn) emitter._events[evt].push(listener);
        else emitter._events[evt] = [emitter._events[evt], listener];
        return emitter;
      }
      function clearEvent(emitter, evt) {
        if (--emitter._eventsCount === 0) emitter._events = new Events();
        else delete emitter._events[evt];
      }
      function EventEmitter() {
        this._events = new Events();
        this._eventsCount = 0;
      }
      EventEmitter.prototype.eventNames = function eventNames() {
        var names = [], events, name;
        if (this._eventsCount === 0) return names;
        for (name in events = this._events) {
          if (has.call(events, name)) names.push(prefix ? name.slice(1) : name);
        }
        if (Object.getOwnPropertySymbols) {
          return names.concat(Object.getOwnPropertySymbols(events));
        }
        return names;
      };
      EventEmitter.prototype.listeners = function listeners(event) {
        var evt = prefix ? prefix + event : event, handlers = this._events[evt];
        if (!handlers) return [];
        if (handlers.fn) return [handlers.fn];
        for (var i = 0, l = handlers.length, ee = new Array(l); i < l; i++) {
          ee[i] = handlers[i].fn;
        }
        return ee;
      };
      EventEmitter.prototype.listenerCount = function listenerCount(event) {
        var evt = prefix ? prefix + event : event, listeners = this._events[evt];
        if (!listeners) return 0;
        if (listeners.fn) return 1;
        return listeners.length;
      };
      EventEmitter.prototype.emit = function emit2(event, a1, a2, a3, a4, a5) {
        var evt = prefix ? prefix + event : event;
        if (!this._events[evt]) return false;
        var listeners = this._events[evt], len = arguments.length, args, i;
        if (listeners.fn) {
          if (listeners.once) this.removeListener(event, listeners.fn, void 0, true);
          switch (len) {
            case 1:
              return listeners.fn.call(listeners.context), true;
            case 2:
              return listeners.fn.call(listeners.context, a1), true;
            case 3:
              return listeners.fn.call(listeners.context, a1, a2), true;
            case 4:
              return listeners.fn.call(listeners.context, a1, a2, a3), true;
            case 5:
              return listeners.fn.call(listeners.context, a1, a2, a3, a4), true;
            case 6:
              return listeners.fn.call(listeners.context, a1, a2, a3, a4, a5), true;
          }
          for (i = 1, args = new Array(len - 1); i < len; i++) {
            args[i - 1] = arguments[i];
          }
          listeners.fn.apply(listeners.context, args);
        } else {
          var length = listeners.length, j;
          for (i = 0; i < length; i++) {
            if (listeners[i].once) this.removeListener(event, listeners[i].fn, void 0, true);
            switch (len) {
              case 1:
                listeners[i].fn.call(listeners[i].context);
                break;
              case 2:
                listeners[i].fn.call(listeners[i].context, a1);
                break;
              case 3:
                listeners[i].fn.call(listeners[i].context, a1, a2);
                break;
              case 4:
                listeners[i].fn.call(listeners[i].context, a1, a2, a3);
                break;
              default:
                if (!args) for (j = 1, args = new Array(len - 1); j < len; j++) {
                  args[j - 1] = arguments[j];
                }
                listeners[i].fn.apply(listeners[i].context, args);
            }
          }
        }
        return true;
      };
      EventEmitter.prototype.on = function on(event, fn, context2) {
        return addListener(this, event, fn, context2, false);
      };
      EventEmitter.prototype.once = function once(event, fn, context2) {
        return addListener(this, event, fn, context2, true);
      };
      EventEmitter.prototype.removeListener = function removeListener(event, fn, context2, once) {
        var evt = prefix ? prefix + event : event;
        if (!this._events[evt]) return this;
        if (!fn) {
          clearEvent(this, evt);
          return this;
        }
        var listeners = this._events[evt];
        if (listeners.fn) {
          if (listeners.fn === fn && (!once || listeners.once) && (!context2 || listeners.context === context2)) {
            clearEvent(this, evt);
          }
        } else {
          for (var i = 0, events = [], length = listeners.length; i < length; i++) {
            if (listeners[i].fn !== fn || once && !listeners[i].once || context2 && listeners[i].context !== context2) {
              events.push(listeners[i]);
            }
          }
          if (events.length) this._events[evt] = events.length === 1 ? events[0] : events;
          else clearEvent(this, evt);
        }
        return this;
      };
      EventEmitter.prototype.removeAllListeners = function removeAllListeners(event) {
        var evt;
        if (event) {
          evt = prefix ? prefix + event : event;
          if (this._events[evt]) clearEvent(this, evt);
        } else {
          this._events = new Events();
          this._eventsCount = 0;
        }
        return this;
      };
      EventEmitter.prototype.off = EventEmitter.prototype.removeListener;
      EventEmitter.prototype.addListener = EventEmitter.prototype.on;
      EventEmitter.prefixed = prefix;
      EventEmitter.EventEmitter = EventEmitter;
      if ("undefined" !== typeof module) {
        module.exports = EventEmitter;
      }
    }
  });

  // node_modules/earcut/src/earcut.js
  var require_earcut = __commonJS({
    "node_modules/earcut/src/earcut.js"(exports, module) {
      "use strict";
      module.exports = earcut;
      module.exports.default = earcut;
      function earcut(data, holeIndices, dim) {
        dim = dim || 2;
        var hasHoles = holeIndices && holeIndices.length, outerLen = hasHoles ? holeIndices[0] * dim : data.length, outerNode = linkedList(data, 0, outerLen, dim, true), triangles = [];
        if (!outerNode || outerNode.next === outerNode.prev) return triangles;
        var minX, minY, maxX, maxY, x, y, invSize;
        if (hasHoles) outerNode = eliminateHoles(data, holeIndices, outerNode, dim);
        if (data.length > 80 * dim) {
          minX = maxX = data[0];
          minY = maxY = data[1];
          for (var i = dim; i < outerLen; i += dim) {
            x = data[i];
            y = data[i + 1];
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
          invSize = Math.max(maxX - minX, maxY - minY);
          invSize = invSize !== 0 ? 32767 / invSize : 0;
        }
        earcutLinked(outerNode, triangles, dim, minX, minY, invSize, 0);
        return triangles;
      }
      function linkedList(data, start, end, dim, clockwise) {
        var i, last;
        if (clockwise === signedArea(data, start, end, dim) > 0) {
          for (i = start; i < end; i += dim) last = insertNode(i, data[i], data[i + 1], last);
        } else {
          for (i = end - dim; i >= start; i -= dim) last = insertNode(i, data[i], data[i + 1], last);
        }
        if (last && equals(last, last.next)) {
          removeNode(last);
          last = last.next;
        }
        return last;
      }
      function filterPoints(start, end) {
        if (!start) return start;
        if (!end) end = start;
        var p = start, again;
        do {
          again = false;
          if (!p.steiner && (equals(p, p.next) || area(p.prev, p, p.next) === 0)) {
            removeNode(p);
            p = end = p.prev;
            if (p === p.next) break;
            again = true;
          } else {
            p = p.next;
          }
        } while (again || p !== end);
        return end;
      }
      function earcutLinked(ear, triangles, dim, minX, minY, invSize, pass) {
        if (!ear) return;
        if (!pass && invSize) indexCurve(ear, minX, minY, invSize);
        var stop = ear, prev, next;
        while (ear.prev !== ear.next) {
          prev = ear.prev;
          next = ear.next;
          if (invSize ? isEarHashed(ear, minX, minY, invSize) : isEar(ear)) {
            triangles.push(prev.i / dim | 0);
            triangles.push(ear.i / dim | 0);
            triangles.push(next.i / dim | 0);
            removeNode(ear);
            ear = next.next;
            stop = next.next;
            continue;
          }
          ear = next;
          if (ear === stop) {
            if (!pass) {
              earcutLinked(filterPoints(ear), triangles, dim, minX, minY, invSize, 1);
            } else if (pass === 1) {
              ear = cureLocalIntersections(filterPoints(ear), triangles, dim);
              earcutLinked(ear, triangles, dim, minX, minY, invSize, 2);
            } else if (pass === 2) {
              splitEarcut(ear, triangles, dim, minX, minY, invSize);
            }
            break;
          }
        }
      }
      function isEar(ear) {
        var a = ear.prev, b = ear, c = ear.next;
        if (area(a, b, c) >= 0) return false;
        var ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y;
        var x0 = ax < bx ? ax < cx ? ax : cx : bx < cx ? bx : cx, y0 = ay < by ? ay < cy ? ay : cy : by < cy ? by : cy, x1 = ax > bx ? ax > cx ? ax : cx : bx > cx ? bx : cx, y1 = ay > by ? ay > cy ? ay : cy : by > cy ? by : cy;
        var p = c.next;
        while (p !== a) {
          if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
          p = p.next;
        }
        return true;
      }
      function isEarHashed(ear, minX, minY, invSize) {
        var a = ear.prev, b = ear, c = ear.next;
        if (area(a, b, c) >= 0) return false;
        var ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y;
        var x0 = ax < bx ? ax < cx ? ax : cx : bx < cx ? bx : cx, y0 = ay < by ? ay < cy ? ay : cy : by < cy ? by : cy, x1 = ax > bx ? ax > cx ? ax : cx : bx > cx ? bx : cx, y1 = ay > by ? ay > cy ? ay : cy : by > cy ? by : cy;
        var minZ = zOrder(x0, y0, minX, minY, invSize), maxZ = zOrder(x1, y1, minX, minY, invSize);
        var p = ear.prevZ, n = ear.nextZ;
        while (p && p.z >= minZ && n && n.z <= maxZ) {
          if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && p !== a && p !== c && pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
          p = p.prevZ;
          if (n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1 && n !== a && n !== c && pointInTriangle(ax, ay, bx, by, cx, cy, n.x, n.y) && area(n.prev, n, n.next) >= 0) return false;
          n = n.nextZ;
        }
        while (p && p.z >= minZ) {
          if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && p !== a && p !== c && pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
          p = p.prevZ;
        }
        while (n && n.z <= maxZ) {
          if (n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1 && n !== a && n !== c && pointInTriangle(ax, ay, bx, by, cx, cy, n.x, n.y) && area(n.prev, n, n.next) >= 0) return false;
          n = n.nextZ;
        }
        return true;
      }
      function cureLocalIntersections(start, triangles, dim) {
        var p = start;
        do {
          var a = p.prev, b = p.next.next;
          if (!equals(a, b) && intersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
            triangles.push(a.i / dim | 0);
            triangles.push(p.i / dim | 0);
            triangles.push(b.i / dim | 0);
            removeNode(p);
            removeNode(p.next);
            p = start = b;
          }
          p = p.next;
        } while (p !== start);
        return filterPoints(p);
      }
      function splitEarcut(start, triangles, dim, minX, minY, invSize) {
        var a = start;
        do {
          var b = a.next.next;
          while (b !== a.prev) {
            if (a.i !== b.i && isValidDiagonal(a, b)) {
              var c = splitPolygon(a, b);
              a = filterPoints(a, a.next);
              c = filterPoints(c, c.next);
              earcutLinked(a, triangles, dim, minX, minY, invSize, 0);
              earcutLinked(c, triangles, dim, minX, minY, invSize, 0);
              return;
            }
            b = b.next;
          }
          a = a.next;
        } while (a !== start);
      }
      function eliminateHoles(data, holeIndices, outerNode, dim) {
        var queue = [], i, len, start, end, list;
        for (i = 0, len = holeIndices.length; i < len; i++) {
          start = holeIndices[i] * dim;
          end = i < len - 1 ? holeIndices[i + 1] * dim : data.length;
          list = linkedList(data, start, end, dim, false);
          if (list === list.next) list.steiner = true;
          queue.push(getLeftmost(list));
        }
        queue.sort(compareX);
        for (i = 0; i < queue.length; i++) {
          outerNode = eliminateHole(queue[i], outerNode);
        }
        return outerNode;
      }
      function compareX(a, b) {
        return a.x - b.x;
      }
      function eliminateHole(hole, outerNode) {
        var bridge = findHoleBridge(hole, outerNode);
        if (!bridge) {
          return outerNode;
        }
        var bridgeReverse = splitPolygon(bridge, hole);
        filterPoints(bridgeReverse, bridgeReverse.next);
        return filterPoints(bridge, bridge.next);
      }
      function findHoleBridge(hole, outerNode) {
        var p = outerNode, hx = hole.x, hy = hole.y, qx = -Infinity, m;
        do {
          if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
            var x = p.x + (hy - p.y) * (p.next.x - p.x) / (p.next.y - p.y);
            if (x <= hx && x > qx) {
              qx = x;
              m = p.x < p.next.x ? p : p.next;
              if (x === hx) return m;
            }
          }
          p = p.next;
        } while (p !== outerNode);
        if (!m) return null;
        var stop = m, mx = m.x, my = m.y, tanMin = Infinity, tan;
        p = m;
        do {
          if (hx >= p.x && p.x >= mx && hx !== p.x && pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)) {
            tan = Math.abs(hy - p.y) / (hx - p.x);
            if (locallyInside(p, hole) && (tan < tanMin || tan === tanMin && (p.x > m.x || p.x === m.x && sectorContainsSector(m, p)))) {
              m = p;
              tanMin = tan;
            }
          }
          p = p.next;
        } while (p !== stop);
        return m;
      }
      function sectorContainsSector(m, p) {
        return area(m.prev, m, p.prev) < 0 && area(p.next, m, m.next) < 0;
      }
      function indexCurve(start, minX, minY, invSize) {
        var p = start;
        do {
          if (p.z === 0) p.z = zOrder(p.x, p.y, minX, minY, invSize);
          p.prevZ = p.prev;
          p.nextZ = p.next;
          p = p.next;
        } while (p !== start);
        p.prevZ.nextZ = null;
        p.prevZ = null;
        sortLinked(p);
      }
      function sortLinked(list) {
        var i, p, q, e, tail, numMerges, pSize, qSize, inSize = 1;
        do {
          p = list;
          list = null;
          tail = null;
          numMerges = 0;
          while (p) {
            numMerges++;
            q = p;
            pSize = 0;
            for (i = 0; i < inSize; i++) {
              pSize++;
              q = q.nextZ;
              if (!q) break;
            }
            qSize = inSize;
            while (pSize > 0 || qSize > 0 && q) {
              if (pSize !== 0 && (qSize === 0 || !q || p.z <= q.z)) {
                e = p;
                p = p.nextZ;
                pSize--;
              } else {
                e = q;
                q = q.nextZ;
                qSize--;
              }
              if (tail) tail.nextZ = e;
              else list = e;
              e.prevZ = tail;
              tail = e;
            }
            p = q;
          }
          tail.nextZ = null;
          inSize *= 2;
        } while (numMerges > 1);
        return list;
      }
      function zOrder(x, y, minX, minY, invSize) {
        x = (x - minX) * invSize | 0;
        y = (y - minY) * invSize | 0;
        x = (x | x << 8) & 16711935;
        x = (x | x << 4) & 252645135;
        x = (x | x << 2) & 858993459;
        x = (x | x << 1) & 1431655765;
        y = (y | y << 8) & 16711935;
        y = (y | y << 4) & 252645135;
        y = (y | y << 2) & 858993459;
        y = (y | y << 1) & 1431655765;
        return x | y << 1;
      }
      function getLeftmost(start) {
        var p = start, leftmost = start;
        do {
          if (p.x < leftmost.x || p.x === leftmost.x && p.y < leftmost.y) leftmost = p;
          p = p.next;
        } while (p !== start);
        return leftmost;
      }
      function pointInTriangle(ax, ay, bx, by, cx, cy, px, py) {
        return (cx - px) * (ay - py) >= (ax - px) * (cy - py) && (ax - px) * (by - py) >= (bx - px) * (ay - py) && (bx - px) * (cy - py) >= (cx - px) * (by - py);
      }
      function isValidDiagonal(a, b) {
        return a.next.i !== b.i && a.prev.i !== b.i && !intersectsPolygon(a, b) && // dones't intersect other edges
        (locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b) && // locally visible
        (area(a.prev, a, b.prev) || area(a, b.prev, b)) || // does not create opposite-facing sectors
        equals(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0);
      }
      function area(p, q, r) {
        return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
      }
      function equals(p1, p2) {
        return p1.x === p2.x && p1.y === p2.y;
      }
      function intersects(p1, q1, p2, q2) {
        var o1 = sign(area(p1, q1, p2));
        var o2 = sign(area(p1, q1, q2));
        var o3 = sign(area(p2, q2, p1));
        var o4 = sign(area(p2, q2, q1));
        if (o1 !== o2 && o3 !== o4) return true;
        if (o1 === 0 && onSegment(p1, p2, q1)) return true;
        if (o2 === 0 && onSegment(p1, q2, q1)) return true;
        if (o3 === 0 && onSegment(p2, p1, q2)) return true;
        if (o4 === 0 && onSegment(p2, q1, q2)) return true;
        return false;
      }
      function onSegment(p, q, r) {
        return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
      }
      function sign(num) {
        return num > 0 ? 1 : num < 0 ? -1 : 0;
      }
      function intersectsPolygon(a, b) {
        var p = a;
        do {
          if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i && intersects(p, p.next, a, b)) return true;
          p = p.next;
        } while (p !== a);
        return false;
      }
      function locallyInside(a, b) {
        return area(a.prev, a, a.next) < 0 ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0 : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0;
      }
      function middleInside(a, b) {
        var p = a, inside = false, px = (a.x + b.x) / 2, py = (a.y + b.y) / 2;
        do {
          if (p.y > py !== p.next.y > py && p.next.y !== p.y && px < (p.next.x - p.x) * (py - p.y) / (p.next.y - p.y) + p.x)
            inside = !inside;
          p = p.next;
        } while (p !== a);
        return inside;
      }
      function splitPolygon(a, b) {
        var a2 = new Node(a.i, a.x, a.y), b2 = new Node(b.i, b.x, b.y), an = a.next, bp = b.prev;
        a.next = b;
        b.prev = a;
        a2.next = an;
        an.prev = a2;
        b2.next = a2;
        a2.prev = b2;
        bp.next = b2;
        b2.prev = bp;
        return b2;
      }
      function insertNode(i, x, y, last) {
        var p = new Node(i, x, y);
        if (!last) {
          p.prev = p;
          p.next = p;
        } else {
          p.next = last.next;
          p.prev = last;
          last.next.prev = p;
          last.next = p;
        }
        return p;
      }
      function removeNode(p) {
        p.next.prev = p.prev;
        p.prev.next = p.next;
        if (p.prevZ) p.prevZ.nextZ = p.nextZ;
        if (p.nextZ) p.nextZ.prevZ = p.prevZ;
      }
      function Node(i, x, y) {
        this.i = i;
        this.x = x;
        this.y = y;
        this.prev = null;
        this.next = null;
        this.z = 0;
        this.prevZ = null;
        this.nextZ = null;
        this.steiner = false;
      }
      earcut.deviation = function(data, holeIndices, dim, triangles) {
        var hasHoles = holeIndices && holeIndices.length;
        var outerLen = hasHoles ? holeIndices[0] * dim : data.length;
        var polygonArea = Math.abs(signedArea(data, 0, outerLen, dim));
        if (hasHoles) {
          for (var i = 0, len = holeIndices.length; i < len; i++) {
            var start = holeIndices[i] * dim;
            var end = i < len - 1 ? holeIndices[i + 1] * dim : data.length;
            polygonArea -= Math.abs(signedArea(data, start, end, dim));
          }
        }
        var trianglesArea = 0;
        for (i = 0; i < triangles.length; i += 3) {
          var a = triangles[i] * dim;
          var b = triangles[i + 1] * dim;
          var c = triangles[i + 2] * dim;
          trianglesArea += Math.abs(
            (data[a] - data[c]) * (data[b + 1] - data[a + 1]) - (data[a] - data[b]) * (data[c + 1] - data[a + 1])
          );
        }
        return polygonArea === 0 && trianglesArea === 0 ? 0 : Math.abs((trianglesArea - polygonArea) / polygonArea);
      };
      function signedArea(data, start, end, dim) {
        var sum = 0;
        for (var i = start, j = end - dim; i < end; i += dim) {
          sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
          j = i;
        }
        return sum;
      }
      earcut.flatten = function(data) {
        var dim = data[0][0].length, result = { vertices: [], holes: [], dimensions: dim }, holeIndex = 0;
        for (var i = 0; i < data.length; i++) {
          for (var j = 0; j < data[i].length; j++) {
            for (var d = 0; d < dim; d++) result.vertices.push(data[i][j][d]);
          }
          if (i > 0) {
            holeIndex += data[i - 1].length;
            result.holes.push(holeIndex);
          }
        }
        return result;
      };
    }
  });

  // node_modules/punycode/punycode.js
  var require_punycode = __commonJS({
    "node_modules/punycode/punycode.js"(exports, module) {
      (function(root) {
        var freeExports = typeof exports == "object" && exports && !exports.nodeType && exports;
        var freeModule = typeof module == "object" && module && !module.nodeType && module;
        var freeGlobal = typeof global == "object" && global;
        if (freeGlobal.global === freeGlobal || freeGlobal.window === freeGlobal || freeGlobal.self === freeGlobal) {
          root = freeGlobal;
        }
        var punycode, maxInt = 2147483647, base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700, initialBias = 72, initialN = 128, delimiter = "-", regexPunycode = /^xn--/, regexNonASCII = /[^\x20-\x7E]/, regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g, errors = {
          "overflow": "Overflow: input needs wider integers to process",
          "not-basic": "Illegal input >= 0x80 (not a basic code point)",
          "invalid-input": "Invalid input"
        }, baseMinusTMin = base - tMin, floor = Math.floor, stringFromCharCode = String.fromCharCode, key;
        function error(type) {
          throw new RangeError(errors[type]);
        }
        function map2(array, fn) {
          var length = array.length;
          var result = [];
          while (length--) {
            result[length] = fn(array[length]);
          }
          return result;
        }
        function mapDomain(string, fn) {
          var parts = string.split("@");
          var result = "";
          if (parts.length > 1) {
            result = parts[0] + "@";
            string = parts[1];
          }
          string = string.replace(regexSeparators, ".");
          var labels = string.split(".");
          var encoded = map2(labels, fn).join(".");
          return result + encoded;
        }
        function ucs2decode(string) {
          var output = [], counter = 0, length = string.length, value, extra;
          while (counter < length) {
            value = string.charCodeAt(counter++);
            if (value >= 55296 && value <= 56319 && counter < length) {
              extra = string.charCodeAt(counter++);
              if ((extra & 64512) == 56320) {
                output.push(((value & 1023) << 10) + (extra & 1023) + 65536);
              } else {
                output.push(value);
                counter--;
              }
            } else {
              output.push(value);
            }
          }
          return output;
        }
        function ucs2encode(array) {
          return map2(array, function(value) {
            var output = "";
            if (value > 65535) {
              value -= 65536;
              output += stringFromCharCode(value >>> 10 & 1023 | 55296);
              value = 56320 | value & 1023;
            }
            output += stringFromCharCode(value);
            return output;
          }).join("");
        }
        function basicToDigit(codePoint) {
          if (codePoint - 48 < 10) {
            return codePoint - 22;
          }
          if (codePoint - 65 < 26) {
            return codePoint - 65;
          }
          if (codePoint - 97 < 26) {
            return codePoint - 97;
          }
          return base;
        }
        function digitToBasic(digit, flag) {
          return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
        }
        function adapt(delta, numPoints, firstTime) {
          var k = 0;
          delta = firstTime ? floor(delta / damp) : delta >> 1;
          delta += floor(delta / numPoints);
          for (; delta > baseMinusTMin * tMax >> 1; k += base) {
            delta = floor(delta / baseMinusTMin);
          }
          return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
        }
        function decode(input) {
          var output = [], inputLength = input.length, out, i = 0, n = initialN, bias = initialBias, basic, j, index, oldi, w, k, digit, t, baseMinusT;
          basic = input.lastIndexOf(delimiter);
          if (basic < 0) {
            basic = 0;
          }
          for (j = 0; j < basic; ++j) {
            if (input.charCodeAt(j) >= 128) {
              error("not-basic");
            }
            output.push(input.charCodeAt(j));
          }
          for (index = basic > 0 ? basic + 1 : 0; index < inputLength; ) {
            for (oldi = i, w = 1, k = base; ; k += base) {
              if (index >= inputLength) {
                error("invalid-input");
              }
              digit = basicToDigit(input.charCodeAt(index++));
              if (digit >= base || digit > floor((maxInt - i) / w)) {
                error("overflow");
              }
              i += digit * w;
              t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
              if (digit < t) {
                break;
              }
              baseMinusT = base - t;
              if (w > floor(maxInt / baseMinusT)) {
                error("overflow");
              }
              w *= baseMinusT;
            }
            out = output.length + 1;
            bias = adapt(i - oldi, out, oldi == 0);
            if (floor(i / out) > maxInt - n) {
              error("overflow");
            }
            n += floor(i / out);
            i %= out;
            output.splice(i++, 0, n);
          }
          return ucs2encode(output);
        }
        function encode(input) {
          var n, delta, handledCPCount, basicLength, bias, j, m, q, k, t, currentValue, output = [], inputLength, handledCPCountPlusOne, baseMinusT, qMinusT;
          input = ucs2decode(input);
          inputLength = input.length;
          n = initialN;
          delta = 0;
          bias = initialBias;
          for (j = 0; j < inputLength; ++j) {
            currentValue = input[j];
            if (currentValue < 128) {
              output.push(stringFromCharCode(currentValue));
            }
          }
          handledCPCount = basicLength = output.length;
          if (basicLength) {
            output.push(delimiter);
          }
          while (handledCPCount < inputLength) {
            for (m = maxInt, j = 0; j < inputLength; ++j) {
              currentValue = input[j];
              if (currentValue >= n && currentValue < m) {
                m = currentValue;
              }
            }
            handledCPCountPlusOne = handledCPCount + 1;
            if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
              error("overflow");
            }
            delta += (m - n) * handledCPCountPlusOne;
            n = m;
            for (j = 0; j < inputLength; ++j) {
              currentValue = input[j];
              if (currentValue < n && ++delta > maxInt) {
                error("overflow");
              }
              if (currentValue == n) {
                for (q = delta, k = base; ; k += base) {
                  t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
                  if (q < t) {
                    break;
                  }
                  qMinusT = q - t;
                  baseMinusT = base - t;
                  output.push(
                    stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))
                  );
                  q = floor(qMinusT / baseMinusT);
                }
                output.push(stringFromCharCode(digitToBasic(q, 0)));
                bias = adapt(delta, handledCPCountPlusOne, handledCPCount == basicLength);
                delta = 0;
                ++handledCPCount;
              }
            }
            ++delta;
            ++n;
          }
          return output.join("");
        }
        function toUnicode(input) {
          return mapDomain(input, function(string) {
            return regexPunycode.test(string) ? decode(string.slice(4).toLowerCase()) : string;
          });
        }
        function toASCII(input) {
          return mapDomain(input, function(string) {
            return regexNonASCII.test(string) ? "xn--" + encode(string) : string;
          });
        }
        punycode = {
          /**
           * A string representing the current Punycode.js version number.
           * @memberOf punycode
           * @type String
           */
          "version": "1.4.1",
          /**
           * An object of methods to convert from JavaScript's internal character
           * representation (UCS-2) to Unicode code points, and back.
           * @see <https://mathiasbynens.be/notes/javascript-encoding>
           * @memberOf punycode
           * @type Object
           */
          "ucs2": {
            "decode": ucs2decode,
            "encode": ucs2encode
          },
          "decode": decode,
          "encode": encode,
          "toASCII": toASCII,
          "toUnicode": toUnicode
        };
        if (typeof define == "function" && typeof define.amd == "object" && define.amd) {
          define("punycode", function() {
            return punycode;
          });
        } else if (freeExports && freeModule) {
          if (module.exports == freeExports) {
            freeModule.exports = punycode;
          } else {
            for (key in punycode) {
              punycode.hasOwnProperty(key) && (freeExports[key] = punycode[key]);
            }
          }
        } else {
          root.punycode = punycode;
        }
      })(exports);
    }
  });

  // node_modules/es-errors/type.js
  var require_type = __commonJS({
    "node_modules/es-errors/type.js"(exports, module) {
      "use strict";
      module.exports = TypeError;
    }
  });

  // (disabled):node_modules/object-inspect/util.inspect
  var require_util = __commonJS({
    "(disabled):node_modules/object-inspect/util.inspect"() {
    }
  });

  // node_modules/object-inspect/index.js
  var require_object_inspect = __commonJS({
    "node_modules/object-inspect/index.js"(exports, module) {
      var hasMap = typeof Map === "function" && Map.prototype;
      var mapSizeDescriptor = Object.getOwnPropertyDescriptor && hasMap ? Object.getOwnPropertyDescriptor(Map.prototype, "size") : null;
      var mapSize2 = hasMap && mapSizeDescriptor && typeof mapSizeDescriptor.get === "function" ? mapSizeDescriptor.get : null;
      var mapForEach = hasMap && Map.prototype.forEach;
      var hasSet = typeof Set === "function" && Set.prototype;
      var setSizeDescriptor = Object.getOwnPropertyDescriptor && hasSet ? Object.getOwnPropertyDescriptor(Set.prototype, "size") : null;
      var setSize = hasSet && setSizeDescriptor && typeof setSizeDescriptor.get === "function" ? setSizeDescriptor.get : null;
      var setForEach = hasSet && Set.prototype.forEach;
      var hasWeakMap = typeof WeakMap === "function" && WeakMap.prototype;
      var weakMapHas = hasWeakMap ? WeakMap.prototype.has : null;
      var hasWeakSet = typeof WeakSet === "function" && WeakSet.prototype;
      var weakSetHas = hasWeakSet ? WeakSet.prototype.has : null;
      var hasWeakRef = typeof WeakRef === "function" && WeakRef.prototype;
      var weakRefDeref = hasWeakRef ? WeakRef.prototype.deref : null;
      var booleanValueOf = Boolean.prototype.valueOf;
      var objectToString = Object.prototype.toString;
      var functionToString = Function.prototype.toString;
      var $match = String.prototype.match;
      var $slice = String.prototype.slice;
      var $replace = String.prototype.replace;
      var $toUpperCase = String.prototype.toUpperCase;
      var $toLowerCase = String.prototype.toLowerCase;
      var $test = RegExp.prototype.test;
      var $concat = Array.prototype.concat;
      var $join = Array.prototype.join;
      var $arrSlice = Array.prototype.slice;
      var $floor = Math.floor;
      var bigIntValueOf = typeof BigInt === "function" ? BigInt.prototype.valueOf : null;
      var gOPS = Object.getOwnPropertySymbols;
      var symToString = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? Symbol.prototype.toString : null;
      var hasShammedSymbols = typeof Symbol === "function" && typeof Symbol.iterator === "object";
      var toStringTag = typeof Symbol === "function" && Symbol.toStringTag && (typeof Symbol.toStringTag === hasShammedSymbols ? "object" : "symbol") ? Symbol.toStringTag : null;
      var isEnumerable = Object.prototype.propertyIsEnumerable;
      var gPO = (typeof Reflect === "function" ? Reflect.getPrototypeOf : Object.getPrototypeOf) || ([].__proto__ === Array.prototype ? function(O) {
        return O.__proto__;
      } : null);
      function addNumericSeparator(num, str) {
        if (num === Infinity || num === -Infinity || num !== num || num && num > -1e3 && num < 1e3 || $test.call(/e/, str)) {
          return str;
        }
        var sepRegex = /[0-9](?=(?:[0-9]{3})+(?![0-9]))/g;
        if (typeof num === "number") {
          var int = num < 0 ? -$floor(-num) : $floor(num);
          if (int !== num) {
            var intStr = String(int);
            var dec = $slice.call(str, intStr.length + 1);
            return $replace.call(intStr, sepRegex, "$&_") + "." + $replace.call($replace.call(dec, /([0-9]{3})/g, "$&_"), /_$/, "");
          }
        }
        return $replace.call(str, sepRegex, "$&_");
      }
      var utilInspect = require_util();
      var inspectCustom = utilInspect.custom;
      var inspectSymbol = isSymbol(inspectCustom) ? inspectCustom : null;
      var quotes = {
        __proto__: null,
        "double": '"',
        single: "'"
      };
      var quoteREs = {
        __proto__: null,
        "double": /(["\\])/g,
        single: /(['\\])/g
      };
      module.exports = function inspect_(obj, options, depth, seen) {
        var opts = options || {};
        if (has(opts, "quoteStyle") && !has(quotes, opts.quoteStyle)) {
          throw new TypeError('option "quoteStyle" must be "single" or "double"');
        }
        if (has(opts, "maxStringLength") && (typeof opts.maxStringLength === "number" ? opts.maxStringLength < 0 && opts.maxStringLength !== Infinity : opts.maxStringLength !== null)) {
          throw new TypeError('option "maxStringLength", if provided, must be a positive integer, Infinity, or `null`');
        }
        var customInspect = has(opts, "customInspect") ? opts.customInspect : true;
        if (typeof customInspect !== "boolean" && customInspect !== "symbol") {
          throw new TypeError("option \"customInspect\", if provided, must be `true`, `false`, or `'symbol'`");
        }
        if (has(opts, "indent") && opts.indent !== null && opts.indent !== "	" && !(parseInt(opts.indent, 10) === opts.indent && opts.indent > 0)) {
          throw new TypeError('option "indent" must be "\\t", an integer > 0, or `null`');
        }
        if (has(opts, "numericSeparator") && typeof opts.numericSeparator !== "boolean") {
          throw new TypeError('option "numericSeparator", if provided, must be `true` or `false`');
        }
        var numericSeparator = opts.numericSeparator;
        if (typeof obj === "undefined") {
          return "undefined";
        }
        if (obj === null) {
          return "null";
        }
        if (typeof obj === "boolean") {
          return obj ? "true" : "false";
        }
        if (typeof obj === "string") {
          return inspectString(obj, opts);
        }
        if (typeof obj === "number") {
          if (obj === 0) {
            return Infinity / obj > 0 ? "0" : "-0";
          }
          var str = String(obj);
          return numericSeparator ? addNumericSeparator(obj, str) : str;
        }
        if (typeof obj === "bigint") {
          var bigIntStr = String(obj) + "n";
          return numericSeparator ? addNumericSeparator(obj, bigIntStr) : bigIntStr;
        }
        var maxDepth = typeof opts.depth === "undefined" ? 5 : opts.depth;
        if (typeof depth === "undefined") {
          depth = 0;
        }
        if (depth >= maxDepth && maxDepth > 0 && typeof obj === "object") {
          return isArray(obj) ? "[Array]" : "[Object]";
        }
        var indent = getIndent(opts, depth);
        if (typeof seen === "undefined") {
          seen = [];
        } else if (indexOf(seen, obj) >= 0) {
          return "[Circular]";
        }
        function inspect(value, from, noIndent) {
          if (from) {
            seen = $arrSlice.call(seen);
            seen.push(from);
          }
          if (noIndent) {
            var newOpts = {
              depth: opts.depth
            };
            if (has(opts, "quoteStyle")) {
              newOpts.quoteStyle = opts.quoteStyle;
            }
            return inspect_(value, newOpts, depth + 1, seen);
          }
          return inspect_(value, opts, depth + 1, seen);
        }
        if (typeof obj === "function" && !isRegExp(obj)) {
          var name = nameOf(obj);
          var keys = arrObjKeys(obj, inspect);
          return "[Function" + (name ? ": " + name : " (anonymous)") + "]" + (keys.length > 0 ? " { " + $join.call(keys, ", ") + " }" : "");
        }
        if (isSymbol(obj)) {
          var symString = hasShammedSymbols ? $replace.call(String(obj), /^(Symbol\(.*\))_[^)]*$/, "$1") : symToString.call(obj);
          return typeof obj === "object" && !hasShammedSymbols ? markBoxed(symString) : symString;
        }
        if (isElement(obj)) {
          var s = "<" + $toLowerCase.call(String(obj.nodeName));
          var attrs = obj.attributes || [];
          for (var i = 0; i < attrs.length; i++) {
            s += " " + attrs[i].name + "=" + wrapQuotes(quote(attrs[i].value), "double", opts);
          }
          s += ">";
          if (obj.childNodes && obj.childNodes.length) {
            s += "...";
          }
          s += "</" + $toLowerCase.call(String(obj.nodeName)) + ">";
          return s;
        }
        if (isArray(obj)) {
          if (obj.length === 0) {
            return "[]";
          }
          var xs = arrObjKeys(obj, inspect);
          if (indent && !singleLineValues(xs)) {
            return "[" + indentedJoin(xs, indent) + "]";
          }
          return "[ " + $join.call(xs, ", ") + " ]";
        }
        if (isError(obj)) {
          var parts = arrObjKeys(obj, inspect);
          if (!("cause" in Error.prototype) && "cause" in obj && !isEnumerable.call(obj, "cause")) {
            return "{ [" + String(obj) + "] " + $join.call($concat.call("[cause]: " + inspect(obj.cause), parts), ", ") + " }";
          }
          if (parts.length === 0) {
            return "[" + String(obj) + "]";
          }
          return "{ [" + String(obj) + "] " + $join.call(parts, ", ") + " }";
        }
        if (typeof obj === "object" && customInspect) {
          if (inspectSymbol && typeof obj[inspectSymbol] === "function" && utilInspect) {
            return utilInspect(obj, { depth: maxDepth - depth });
          } else if (customInspect !== "symbol" && typeof obj.inspect === "function") {
            return obj.inspect();
          }
        }
        if (isMap(obj)) {
          var mapParts = [];
          if (mapForEach) {
            mapForEach.call(obj, function(value, key) {
              mapParts.push(inspect(key, obj, true) + " => " + inspect(value, obj));
            });
          }
          return collectionOf("Map", mapSize2.call(obj), mapParts, indent);
        }
        if (isSet(obj)) {
          var setParts = [];
          if (setForEach) {
            setForEach.call(obj, function(value) {
              setParts.push(inspect(value, obj));
            });
          }
          return collectionOf("Set", setSize.call(obj), setParts, indent);
        }
        if (isWeakMap(obj)) {
          return weakCollectionOf("WeakMap");
        }
        if (isWeakSet(obj)) {
          return weakCollectionOf("WeakSet");
        }
        if (isWeakRef(obj)) {
          return weakCollectionOf("WeakRef");
        }
        if (isNumber(obj)) {
          return markBoxed(inspect(Number(obj)));
        }
        if (isBigInt(obj)) {
          return markBoxed(inspect(bigIntValueOf.call(obj)));
        }
        if (isBoolean(obj)) {
          return markBoxed(booleanValueOf.call(obj));
        }
        if (isString(obj)) {
          return markBoxed(inspect(String(obj)));
        }
        if (typeof window !== "undefined" && obj === window) {
          return "{ [object Window] }";
        }
        if (typeof globalThis !== "undefined" && obj === globalThis || typeof global !== "undefined" && obj === global) {
          return "{ [object globalThis] }";
        }
        if (!isDate(obj) && !isRegExp(obj)) {
          var ys = arrObjKeys(obj, inspect);
          var isPlainObject = gPO ? gPO(obj) === Object.prototype : obj instanceof Object || obj.constructor === Object;
          var protoTag = obj instanceof Object ? "" : "null prototype";
          var stringTag = !isPlainObject && toStringTag && Object(obj) === obj && toStringTag in obj ? $slice.call(toStr(obj), 8, -1) : protoTag ? "Object" : "";
          var constructorTag = isPlainObject || typeof obj.constructor !== "function" ? "" : obj.constructor.name ? obj.constructor.name + " " : "";
          var tag = constructorTag + (stringTag || protoTag ? "[" + $join.call($concat.call([], stringTag || [], protoTag || []), ": ") + "] " : "");
          if (ys.length === 0) {
            return tag + "{}";
          }
          if (indent) {
            return tag + "{" + indentedJoin(ys, indent) + "}";
          }
          return tag + "{ " + $join.call(ys, ", ") + " }";
        }
        return String(obj);
      };
      function wrapQuotes(s, defaultStyle, opts) {
        var style = opts.quoteStyle || defaultStyle;
        var quoteChar = quotes[style];
        return quoteChar + s + quoteChar;
      }
      function quote(s) {
        return $replace.call(String(s), /"/g, "&quot;");
      }
      function canTrustToString(obj) {
        return !toStringTag || !(typeof obj === "object" && (toStringTag in obj || typeof obj[toStringTag] !== "undefined"));
      }
      function isArray(obj) {
        return toStr(obj) === "[object Array]" && canTrustToString(obj);
      }
      function isDate(obj) {
        return toStr(obj) === "[object Date]" && canTrustToString(obj);
      }
      function isRegExp(obj) {
        return toStr(obj) === "[object RegExp]" && canTrustToString(obj);
      }
      function isError(obj) {
        return toStr(obj) === "[object Error]" && canTrustToString(obj);
      }
      function isString(obj) {
        return toStr(obj) === "[object String]" && canTrustToString(obj);
      }
      function isNumber(obj) {
        return toStr(obj) === "[object Number]" && canTrustToString(obj);
      }
      function isBoolean(obj) {
        return toStr(obj) === "[object Boolean]" && canTrustToString(obj);
      }
      function isSymbol(obj) {
        if (hasShammedSymbols) {
          return obj && typeof obj === "object" && obj instanceof Symbol;
        }
        if (typeof obj === "symbol") {
          return true;
        }
        if (!obj || typeof obj !== "object" || !symToString) {
          return false;
        }
        try {
          symToString.call(obj);
          return true;
        } catch (e) {
        }
        return false;
      }
      function isBigInt(obj) {
        if (!obj || typeof obj !== "object" || !bigIntValueOf) {
          return false;
        }
        try {
          bigIntValueOf.call(obj);
          return true;
        } catch (e) {
        }
        return false;
      }
      var hasOwn = Object.prototype.hasOwnProperty || function(key) {
        return key in this;
      };
      function has(obj, key) {
        return hasOwn.call(obj, key);
      }
      function toStr(obj) {
        return objectToString.call(obj);
      }
      function nameOf(f) {
        if (f.name) {
          return f.name;
        }
        var m = $match.call(functionToString.call(f), /^function\s*([\w$]+)/);
        if (m) {
          return m[1];
        }
        return null;
      }
      function indexOf(xs, x) {
        if (xs.indexOf) {
          return xs.indexOf(x);
        }
        for (var i = 0, l = xs.length; i < l; i++) {
          if (xs[i] === x) {
            return i;
          }
        }
        return -1;
      }
      function isMap(x) {
        if (!mapSize2 || !x || typeof x !== "object") {
          return false;
        }
        try {
          mapSize2.call(x);
          try {
            setSize.call(x);
          } catch (s) {
            return true;
          }
          return x instanceof Map;
        } catch (e) {
        }
        return false;
      }
      function isWeakMap(x) {
        if (!weakMapHas || !x || typeof x !== "object") {
          return false;
        }
        try {
          weakMapHas.call(x, weakMapHas);
          try {
            weakSetHas.call(x, weakSetHas);
          } catch (s) {
            return true;
          }
          return x instanceof WeakMap;
        } catch (e) {
        }
        return false;
      }
      function isWeakRef(x) {
        if (!weakRefDeref || !x || typeof x !== "object") {
          return false;
        }
        try {
          weakRefDeref.call(x);
          return true;
        } catch (e) {
        }
        return false;
      }
      function isSet(x) {
        if (!setSize || !x || typeof x !== "object") {
          return false;
        }
        try {
          setSize.call(x);
          try {
            mapSize2.call(x);
          } catch (m) {
            return true;
          }
          return x instanceof Set;
        } catch (e) {
        }
        return false;
      }
      function isWeakSet(x) {
        if (!weakSetHas || !x || typeof x !== "object") {
          return false;
        }
        try {
          weakSetHas.call(x, weakSetHas);
          try {
            weakMapHas.call(x, weakMapHas);
          } catch (s) {
            return true;
          }
          return x instanceof WeakSet;
        } catch (e) {
        }
        return false;
      }
      function isElement(x) {
        if (!x || typeof x !== "object") {
          return false;
        }
        if (typeof HTMLElement !== "undefined" && x instanceof HTMLElement) {
          return true;
        }
        return typeof x.nodeName === "string" && typeof x.getAttribute === "function";
      }
      function inspectString(str, opts) {
        if (str.length > opts.maxStringLength) {
          var remaining = str.length - opts.maxStringLength;
          var trailer = "... " + remaining + " more character" + (remaining > 1 ? "s" : "");
          return inspectString($slice.call(str, 0, opts.maxStringLength), opts) + trailer;
        }
        var quoteRE = quoteREs[opts.quoteStyle || "single"];
        quoteRE.lastIndex = 0;
        var s = $replace.call($replace.call(str, quoteRE, "\\$1"), /[\x00-\x1f]/g, lowbyte);
        return wrapQuotes(s, "single", opts);
      }
      function lowbyte(c) {
        var n = c.charCodeAt(0);
        var x = {
          8: "b",
          9: "t",
          10: "n",
          12: "f",
          13: "r"
        }[n];
        if (x) {
          return "\\" + x;
        }
        return "\\x" + (n < 16 ? "0" : "") + $toUpperCase.call(n.toString(16));
      }
      function markBoxed(str) {
        return "Object(" + str + ")";
      }
      function weakCollectionOf(type) {
        return type + " { ? }";
      }
      function collectionOf(type, size, entries, indent) {
        var joinedEntries = indent ? indentedJoin(entries, indent) : $join.call(entries, ", ");
        return type + " (" + size + ") {" + joinedEntries + "}";
      }
      function singleLineValues(xs) {
        for (var i = 0; i < xs.length; i++) {
          if (indexOf(xs[i], "\n") >= 0) {
            return false;
          }
        }
        return true;
      }
      function getIndent(opts, depth) {
        var baseIndent;
        if (opts.indent === "	") {
          baseIndent = "	";
        } else if (typeof opts.indent === "number" && opts.indent > 0) {
          baseIndent = $join.call(Array(opts.indent + 1), " ");
        } else {
          return null;
        }
        return {
          base: baseIndent,
          prev: $join.call(Array(depth + 1), baseIndent)
        };
      }
      function indentedJoin(xs, indent) {
        if (xs.length === 0) {
          return "";
        }
        var lineJoiner = "\n" + indent.prev + indent.base;
        return lineJoiner + $join.call(xs, "," + lineJoiner) + "\n" + indent.prev;
      }
      function arrObjKeys(obj, inspect) {
        var isArr = isArray(obj);
        var xs = [];
        if (isArr) {
          xs.length = obj.length;
          for (var i = 0; i < obj.length; i++) {
            xs[i] = has(obj, i) ? inspect(obj[i], obj) : "";
          }
        }
        var syms = typeof gOPS === "function" ? gOPS(obj) : [];
        var symMap;
        if (hasShammedSymbols) {
          symMap = {};
          for (var k = 0; k < syms.length; k++) {
            symMap["$" + syms[k]] = syms[k];
          }
        }
        for (var key in obj) {
          if (!has(obj, key)) {
            continue;
          }
          if (isArr && String(Number(key)) === key && key < obj.length) {
            continue;
          }
          if (hasShammedSymbols && symMap["$" + key] instanceof Symbol) {
            continue;
          } else if ($test.call(/[^\w$]/, key)) {
            xs.push(inspect(key, obj) + ": " + inspect(obj[key], obj));
          } else {
            xs.push(key + ": " + inspect(obj[key], obj));
          }
        }
        if (typeof gOPS === "function") {
          for (var j = 0; j < syms.length; j++) {
            if (isEnumerable.call(obj, syms[j])) {
              xs.push("[" + inspect(syms[j]) + "]: " + inspect(obj[syms[j]], obj));
            }
          }
        }
        return xs;
      }
    }
  });

  // node_modules/side-channel-list/index.js
  var require_side_channel_list = __commonJS({
    "node_modules/side-channel-list/index.js"(exports, module) {
      "use strict";
      var inspect = require_object_inspect();
      var $TypeError = require_type();
      var listGetNode = function(list, key, isDelete) {
        var prev = list;
        var curr;
        for (; (curr = prev.next) != null; prev = curr) {
          if (curr.key === key) {
            prev.next = curr.next;
            if (!isDelete) {
              curr.next = /** @type {NonNullable<typeof list.next>} */
              list.next;
              list.next = curr;
            }
            return curr;
          }
        }
      };
      var listGet = function(objects, key) {
        if (!objects) {
          return void 0;
        }
        var node = listGetNode(objects, key);
        return node && node.value;
      };
      var listSet = function(objects, key, value) {
        var node = listGetNode(objects, key);
        if (node) {
          node.value = value;
        } else {
          objects.next = /** @type {import('./list.d.ts').ListNode<typeof value, typeof key>} */
          {
            // eslint-disable-line no-param-reassign, no-extra-parens
            key,
            next: objects.next,
            value
          };
        }
      };
      var listHas = function(objects, key) {
        if (!objects) {
          return false;
        }
        return !!listGetNode(objects, key);
      };
      var listDelete = function(objects, key) {
        if (objects) {
          return listGetNode(objects, key, true);
        }
      };
      module.exports = function getSideChannelList() {
        var $o;
        var channel = {
          assert: function(key) {
            if (!channel.has(key)) {
              throw new $TypeError("Side channel does not contain " + inspect(key));
            }
          },
          "delete": function(key) {
            var deletedNode = listDelete($o, key);
            if (deletedNode && $o && !$o.next) {
              $o = void 0;
            }
            return !!deletedNode;
          },
          get: function(key) {
            return listGet($o, key);
          },
          has: function(key) {
            return listHas($o, key);
          },
          set: function(key, value) {
            if (!$o) {
              $o = {
                next: void 0
              };
            }
            listSet(
              /** @type {NonNullable<typeof $o>} */
              $o,
              key,
              value
            );
          }
        };
        return channel;
      };
    }
  });

  // node_modules/es-object-atoms/index.js
  var require_es_object_atoms = __commonJS({
    "node_modules/es-object-atoms/index.js"(exports, module) {
      "use strict";
      module.exports = Object;
    }
  });

  // node_modules/es-errors/index.js
  var require_es_errors = __commonJS({
    "node_modules/es-errors/index.js"(exports, module) {
      "use strict";
      module.exports = Error;
    }
  });

  // node_modules/es-errors/eval.js
  var require_eval = __commonJS({
    "node_modules/es-errors/eval.js"(exports, module) {
      "use strict";
      module.exports = EvalError;
    }
  });

  // node_modules/es-errors/range.js
  var require_range = __commonJS({
    "node_modules/es-errors/range.js"(exports, module) {
      "use strict";
      module.exports = RangeError;
    }
  });

  // node_modules/es-errors/ref.js
  var require_ref = __commonJS({
    "node_modules/es-errors/ref.js"(exports, module) {
      "use strict";
      module.exports = ReferenceError;
    }
  });

  // node_modules/es-errors/syntax.js
  var require_syntax = __commonJS({
    "node_modules/es-errors/syntax.js"(exports, module) {
      "use strict";
      module.exports = SyntaxError;
    }
  });

  // node_modules/es-errors/uri.js
  var require_uri = __commonJS({
    "node_modules/es-errors/uri.js"(exports, module) {
      "use strict";
      module.exports = URIError;
    }
  });

  // node_modules/math-intrinsics/abs.js
  var require_abs = __commonJS({
    "node_modules/math-intrinsics/abs.js"(exports, module) {
      "use strict";
      module.exports = Math.abs;
    }
  });

  // node_modules/math-intrinsics/floor.js
  var require_floor = __commonJS({
    "node_modules/math-intrinsics/floor.js"(exports, module) {
      "use strict";
      module.exports = Math.floor;
    }
  });

  // node_modules/math-intrinsics/max.js
  var require_max = __commonJS({
    "node_modules/math-intrinsics/max.js"(exports, module) {
      "use strict";
      module.exports = Math.max;
    }
  });

  // node_modules/math-intrinsics/min.js
  var require_min = __commonJS({
    "node_modules/math-intrinsics/min.js"(exports, module) {
      "use strict";
      module.exports = Math.min;
    }
  });

  // node_modules/math-intrinsics/pow.js
  var require_pow = __commonJS({
    "node_modules/math-intrinsics/pow.js"(exports, module) {
      "use strict";
      module.exports = Math.pow;
    }
  });

  // node_modules/math-intrinsics/round.js
  var require_round = __commonJS({
    "node_modules/math-intrinsics/round.js"(exports, module) {
      "use strict";
      module.exports = Math.round;
    }
  });

  // node_modules/math-intrinsics/isNaN.js
  var require_isNaN = __commonJS({
    "node_modules/math-intrinsics/isNaN.js"(exports, module) {
      "use strict";
      module.exports = Number.isNaN || function isNaN2(a) {
        return a !== a;
      };
    }
  });

  // node_modules/math-intrinsics/sign.js
  var require_sign = __commonJS({
    "node_modules/math-intrinsics/sign.js"(exports, module) {
      "use strict";
      var $isNaN = require_isNaN();
      module.exports = function sign(number) {
        if ($isNaN(number) || number === 0) {
          return number;
        }
        return number < 0 ? -1 : 1;
      };
    }
  });

  // node_modules/gopd/gOPD.js
  var require_gOPD = __commonJS({
    "node_modules/gopd/gOPD.js"(exports, module) {
      "use strict";
      module.exports = Object.getOwnPropertyDescriptor;
    }
  });

  // node_modules/gopd/index.js
  var require_gopd = __commonJS({
    "node_modules/gopd/index.js"(exports, module) {
      "use strict";
      var $gOPD = require_gOPD();
      if ($gOPD) {
        try {
          $gOPD([], "length");
        } catch (e) {
          $gOPD = null;
        }
      }
      module.exports = $gOPD;
    }
  });

  // node_modules/es-define-property/index.js
  var require_es_define_property = __commonJS({
    "node_modules/es-define-property/index.js"(exports, module) {
      "use strict";
      var $defineProperty = Object.defineProperty || false;
      if ($defineProperty) {
        try {
          $defineProperty({}, "a", { value: 1 });
        } catch (e) {
          $defineProperty = false;
        }
      }
      module.exports = $defineProperty;
    }
  });

  // node_modules/has-symbols/shams.js
  var require_shams = __commonJS({
    "node_modules/has-symbols/shams.js"(exports, module) {
      "use strict";
      module.exports = function hasSymbols() {
        if (typeof Symbol !== "function" || typeof Object.getOwnPropertySymbols !== "function") {
          return false;
        }
        if (typeof Symbol.iterator === "symbol") {
          return true;
        }
        var obj = {};
        var sym = Symbol("test");
        var symObj = Object(sym);
        if (typeof sym === "string") {
          return false;
        }
        if (Object.prototype.toString.call(sym) !== "[object Symbol]") {
          return false;
        }
        if (Object.prototype.toString.call(symObj) !== "[object Symbol]") {
          return false;
        }
        var symVal = 42;
        obj[sym] = symVal;
        for (var _ in obj) {
          return false;
        }
        if (typeof Object.keys === "function" && Object.keys(obj).length !== 0) {
          return false;
        }
        if (typeof Object.getOwnPropertyNames === "function" && Object.getOwnPropertyNames(obj).length !== 0) {
          return false;
        }
        var syms = Object.getOwnPropertySymbols(obj);
        if (syms.length !== 1 || syms[0] !== sym) {
          return false;
        }
        if (!Object.prototype.propertyIsEnumerable.call(obj, sym)) {
          return false;
        }
        if (typeof Object.getOwnPropertyDescriptor === "function") {
          var descriptor = (
            /** @type {PropertyDescriptor} */
            Object.getOwnPropertyDescriptor(obj, sym)
          );
          if (descriptor.value !== symVal || descriptor.enumerable !== true) {
            return false;
          }
        }
        return true;
      };
    }
  });

  // node_modules/has-symbols/index.js
  var require_has_symbols = __commonJS({
    "node_modules/has-symbols/index.js"(exports, module) {
      "use strict";
      var origSymbol = typeof Symbol !== "undefined" && Symbol;
      var hasSymbolSham = require_shams();
      module.exports = function hasNativeSymbols() {
        if (typeof origSymbol !== "function") {
          return false;
        }
        if (typeof Symbol !== "function") {
          return false;
        }
        if (typeof origSymbol("foo") !== "symbol") {
          return false;
        }
        if (typeof Symbol("bar") !== "symbol") {
          return false;
        }
        return hasSymbolSham();
      };
    }
  });

  // node_modules/get-proto/Reflect.getPrototypeOf.js
  var require_Reflect_getPrototypeOf = __commonJS({
    "node_modules/get-proto/Reflect.getPrototypeOf.js"(exports, module) {
      "use strict";
      module.exports = typeof Reflect !== "undefined" && Reflect.getPrototypeOf || null;
    }
  });

  // node_modules/get-proto/Object.getPrototypeOf.js
  var require_Object_getPrototypeOf = __commonJS({
    "node_modules/get-proto/Object.getPrototypeOf.js"(exports, module) {
      "use strict";
      var $Object = require_es_object_atoms();
      module.exports = $Object.getPrototypeOf || null;
    }
  });

  // node_modules/function-bind/implementation.js
  var require_implementation = __commonJS({
    "node_modules/function-bind/implementation.js"(exports, module) {
      "use strict";
      var ERROR_MESSAGE = "Function.prototype.bind called on incompatible ";
      var toStr = Object.prototype.toString;
      var max = Math.max;
      var funcType = "[object Function]";
      var concatty = function concatty2(a, b) {
        var arr = [];
        for (var i = 0; i < a.length; i += 1) {
          arr[i] = a[i];
        }
        for (var j = 0; j < b.length; j += 1) {
          arr[j + a.length] = b[j];
        }
        return arr;
      };
      var slicy = function slicy2(arrLike, offset) {
        var arr = [];
        for (var i = offset || 0, j = 0; i < arrLike.length; i += 1, j += 1) {
          arr[j] = arrLike[i];
        }
        return arr;
      };
      var joiny = function(arr, joiner) {
        var str = "";
        for (var i = 0; i < arr.length; i += 1) {
          str += arr[i];
          if (i + 1 < arr.length) {
            str += joiner;
          }
        }
        return str;
      };
      module.exports = function bind(that) {
        var target = this;
        if (typeof target !== "function" || toStr.apply(target) !== funcType) {
          throw new TypeError(ERROR_MESSAGE + target);
        }
        var args = slicy(arguments, 1);
        var bound;
        var binder = function() {
          if (this instanceof bound) {
            var result = target.apply(
              this,
              concatty(args, arguments)
            );
            if (Object(result) === result) {
              return result;
            }
            return this;
          }
          return target.apply(
            that,
            concatty(args, arguments)
          );
        };
        var boundLength = max(0, target.length - args.length);
        var boundArgs = [];
        for (var i = 0; i < boundLength; i++) {
          boundArgs[i] = "$" + i;
        }
        bound = Function("binder", "return function (" + joiny(boundArgs, ",") + "){ return binder.apply(this,arguments); }")(binder);
        if (target.prototype) {
          var Empty = function Empty2() {
          };
          Empty.prototype = target.prototype;
          bound.prototype = new Empty();
          Empty.prototype = null;
        }
        return bound;
      };
    }
  });

  // node_modules/function-bind/index.js
  var require_function_bind = __commonJS({
    "node_modules/function-bind/index.js"(exports, module) {
      "use strict";
      var implementation = require_implementation();
      module.exports = Function.prototype.bind || implementation;
    }
  });

  // node_modules/call-bind-apply-helpers/functionCall.js
  var require_functionCall = __commonJS({
    "node_modules/call-bind-apply-helpers/functionCall.js"(exports, module) {
      "use strict";
      module.exports = Function.prototype.call;
    }
  });

  // node_modules/call-bind-apply-helpers/functionApply.js
  var require_functionApply = __commonJS({
    "node_modules/call-bind-apply-helpers/functionApply.js"(exports, module) {
      "use strict";
      module.exports = Function.prototype.apply;
    }
  });

  // node_modules/call-bind-apply-helpers/reflectApply.js
  var require_reflectApply = __commonJS({
    "node_modules/call-bind-apply-helpers/reflectApply.js"(exports, module) {
      "use strict";
      module.exports = typeof Reflect !== "undefined" && Reflect && Reflect.apply;
    }
  });

  // node_modules/call-bind-apply-helpers/actualApply.js
  var require_actualApply = __commonJS({
    "node_modules/call-bind-apply-helpers/actualApply.js"(exports, module) {
      "use strict";
      var bind = require_function_bind();
      var $apply = require_functionApply();
      var $call = require_functionCall();
      var $reflectApply = require_reflectApply();
      module.exports = $reflectApply || bind.call($call, $apply);
    }
  });

  // node_modules/call-bind-apply-helpers/index.js
  var require_call_bind_apply_helpers = __commonJS({
    "node_modules/call-bind-apply-helpers/index.js"(exports, module) {
      "use strict";
      var bind = require_function_bind();
      var $TypeError = require_type();
      var $call = require_functionCall();
      var $actualApply = require_actualApply();
      module.exports = function callBindBasic(args) {
        if (args.length < 1 || typeof args[0] !== "function") {
          throw new $TypeError("a function is required");
        }
        return $actualApply(bind, $call, args);
      };
    }
  });

  // node_modules/dunder-proto/get.js
  var require_get = __commonJS({
    "node_modules/dunder-proto/get.js"(exports, module) {
      "use strict";
      var callBind = require_call_bind_apply_helpers();
      var gOPD = require_gopd();
      var hasProtoAccessor;
      try {
        hasProtoAccessor = /** @type {{ __proto__?: typeof Array.prototype }} */
        [].__proto__ === Array.prototype;
      } catch (e) {
        if (!e || typeof e !== "object" || !("code" in e) || e.code !== "ERR_PROTO_ACCESS") {
          throw e;
        }
      }
      var desc = !!hasProtoAccessor && gOPD && gOPD(
        Object.prototype,
        /** @type {keyof typeof Object.prototype} */
        "__proto__"
      );
      var $Object = Object;
      var $getPrototypeOf = $Object.getPrototypeOf;
      module.exports = desc && typeof desc.get === "function" ? callBind([desc.get]) : typeof $getPrototypeOf === "function" ? (
        /** @type {import('./get')} */
        function getDunder(value) {
          return $getPrototypeOf(value == null ? value : $Object(value));
        }
      ) : false;
    }
  });

  // node_modules/get-proto/index.js
  var require_get_proto = __commonJS({
    "node_modules/get-proto/index.js"(exports, module) {
      "use strict";
      var reflectGetProto = require_Reflect_getPrototypeOf();
      var originalGetProto = require_Object_getPrototypeOf();
      var getDunderProto = require_get();
      module.exports = reflectGetProto ? function getProto(O) {
        return reflectGetProto(O);
      } : originalGetProto ? function getProto(O) {
        if (!O || typeof O !== "object" && typeof O !== "function") {
          throw new TypeError("getProto: not an object");
        }
        return originalGetProto(O);
      } : getDunderProto ? function getProto(O) {
        return getDunderProto(O);
      } : null;
    }
  });

  // node_modules/hasown/index.js
  var require_hasown = __commonJS({
    "node_modules/hasown/index.js"(exports, module) {
      "use strict";
      var call = Function.prototype.call;
      var $hasOwn = Object.prototype.hasOwnProperty;
      var bind = require_function_bind();
      module.exports = bind.call(call, $hasOwn);
    }
  });

  // node_modules/get-intrinsic/index.js
  var require_get_intrinsic = __commonJS({
    "node_modules/get-intrinsic/index.js"(exports, module) {
      "use strict";
      var undefined2;
      var $Object = require_es_object_atoms();
      var $Error = require_es_errors();
      var $EvalError = require_eval();
      var $RangeError = require_range();
      var $ReferenceError = require_ref();
      var $SyntaxError = require_syntax();
      var $TypeError = require_type();
      var $URIError = require_uri();
      var abs = require_abs();
      var floor = require_floor();
      var max = require_max();
      var min = require_min();
      var pow = require_pow();
      var round = require_round();
      var sign = require_sign();
      var $Function = Function;
      var getEvalledConstructor = function(expressionSyntax) {
        try {
          return $Function('"use strict"; return (' + expressionSyntax + ").constructor;")();
        } catch (e) {
        }
      };
      var $gOPD = require_gopd();
      var $defineProperty = require_es_define_property();
      var throwTypeError = function() {
        throw new $TypeError();
      };
      var ThrowTypeError = $gOPD ? (function() {
        try {
          arguments.callee;
          return throwTypeError;
        } catch (calleeThrows) {
          try {
            return $gOPD(arguments, "callee").get;
          } catch (gOPDthrows) {
            return throwTypeError;
          }
        }
      })() : throwTypeError;
      var hasSymbols = require_has_symbols()();
      var getProto = require_get_proto();
      var $ObjectGPO = require_Object_getPrototypeOf();
      var $ReflectGPO = require_Reflect_getPrototypeOf();
      var $apply = require_functionApply();
      var $call = require_functionCall();
      var needsEval = {};
      var TypedArray = typeof Uint8Array === "undefined" || !getProto ? undefined2 : getProto(Uint8Array);
      var INTRINSICS = {
        __proto__: null,
        "%AggregateError%": typeof AggregateError === "undefined" ? undefined2 : AggregateError,
        "%Array%": Array,
        "%ArrayBuffer%": typeof ArrayBuffer === "undefined" ? undefined2 : ArrayBuffer,
        "%ArrayIteratorPrototype%": hasSymbols && getProto ? getProto([][Symbol.iterator]()) : undefined2,
        "%AsyncFromSyncIteratorPrototype%": undefined2,
        "%AsyncFunction%": needsEval,
        "%AsyncGenerator%": needsEval,
        "%AsyncGeneratorFunction%": needsEval,
        "%AsyncIteratorPrototype%": needsEval,
        "%Atomics%": typeof Atomics === "undefined" ? undefined2 : Atomics,
        "%BigInt%": typeof BigInt === "undefined" ? undefined2 : BigInt,
        "%BigInt64Array%": typeof BigInt64Array === "undefined" ? undefined2 : BigInt64Array,
        "%BigUint64Array%": typeof BigUint64Array === "undefined" ? undefined2 : BigUint64Array,
        "%Boolean%": Boolean,
        "%DataView%": typeof DataView === "undefined" ? undefined2 : DataView,
        "%Date%": Date,
        "%decodeURI%": decodeURI,
        "%decodeURIComponent%": decodeURIComponent,
        "%encodeURI%": encodeURI,
        "%encodeURIComponent%": encodeURIComponent,
        "%Error%": $Error,
        "%eval%": eval,
        // eslint-disable-line no-eval
        "%EvalError%": $EvalError,
        "%Float16Array%": typeof Float16Array === "undefined" ? undefined2 : Float16Array,
        "%Float32Array%": typeof Float32Array === "undefined" ? undefined2 : Float32Array,
        "%Float64Array%": typeof Float64Array === "undefined" ? undefined2 : Float64Array,
        "%FinalizationRegistry%": typeof FinalizationRegistry === "undefined" ? undefined2 : FinalizationRegistry,
        "%Function%": $Function,
        "%GeneratorFunction%": needsEval,
        "%Int8Array%": typeof Int8Array === "undefined" ? undefined2 : Int8Array,
        "%Int16Array%": typeof Int16Array === "undefined" ? undefined2 : Int16Array,
        "%Int32Array%": typeof Int32Array === "undefined" ? undefined2 : Int32Array,
        "%isFinite%": isFinite,
        "%isNaN%": isNaN,
        "%IteratorPrototype%": hasSymbols && getProto ? getProto(getProto([][Symbol.iterator]())) : undefined2,
        "%JSON%": typeof JSON === "object" ? JSON : undefined2,
        "%Map%": typeof Map === "undefined" ? undefined2 : Map,
        "%MapIteratorPrototype%": typeof Map === "undefined" || !hasSymbols || !getProto ? undefined2 : getProto((/* @__PURE__ */ new Map())[Symbol.iterator]()),
        "%Math%": Math,
        "%Number%": Number,
        "%Object%": $Object,
        "%Object.getOwnPropertyDescriptor%": $gOPD,
        "%parseFloat%": parseFloat,
        "%parseInt%": parseInt,
        "%Promise%": typeof Promise === "undefined" ? undefined2 : Promise,
        "%Proxy%": typeof Proxy === "undefined" ? undefined2 : Proxy,
        "%RangeError%": $RangeError,
        "%ReferenceError%": $ReferenceError,
        "%Reflect%": typeof Reflect === "undefined" ? undefined2 : Reflect,
        "%RegExp%": RegExp,
        "%Set%": typeof Set === "undefined" ? undefined2 : Set,
        "%SetIteratorPrototype%": typeof Set === "undefined" || !hasSymbols || !getProto ? undefined2 : getProto((/* @__PURE__ */ new Set())[Symbol.iterator]()),
        "%SharedArrayBuffer%": typeof SharedArrayBuffer === "undefined" ? undefined2 : SharedArrayBuffer,
        "%String%": String,
        "%StringIteratorPrototype%": hasSymbols && getProto ? getProto(""[Symbol.iterator]()) : undefined2,
        "%Symbol%": hasSymbols ? Symbol : undefined2,
        "%SyntaxError%": $SyntaxError,
        "%ThrowTypeError%": ThrowTypeError,
        "%TypedArray%": TypedArray,
        "%TypeError%": $TypeError,
        "%Uint8Array%": typeof Uint8Array === "undefined" ? undefined2 : Uint8Array,
        "%Uint8ClampedArray%": typeof Uint8ClampedArray === "undefined" ? undefined2 : Uint8ClampedArray,
        "%Uint16Array%": typeof Uint16Array === "undefined" ? undefined2 : Uint16Array,
        "%Uint32Array%": typeof Uint32Array === "undefined" ? undefined2 : Uint32Array,
        "%URIError%": $URIError,
        "%WeakMap%": typeof WeakMap === "undefined" ? undefined2 : WeakMap,
        "%WeakRef%": typeof WeakRef === "undefined" ? undefined2 : WeakRef,
        "%WeakSet%": typeof WeakSet === "undefined" ? undefined2 : WeakSet,
        "%Function.prototype.call%": $call,
        "%Function.prototype.apply%": $apply,
        "%Object.defineProperty%": $defineProperty,
        "%Object.getPrototypeOf%": $ObjectGPO,
        "%Math.abs%": abs,
        "%Math.floor%": floor,
        "%Math.max%": max,
        "%Math.min%": min,
        "%Math.pow%": pow,
        "%Math.round%": round,
        "%Math.sign%": sign,
        "%Reflect.getPrototypeOf%": $ReflectGPO
      };
      if (getProto) {
        try {
          null.error;
        } catch (e) {
          errorProto = getProto(getProto(e));
          INTRINSICS["%Error.prototype%"] = errorProto;
        }
      }
      var errorProto;
      var doEval = function doEval2(name) {
        var value;
        if (name === "%AsyncFunction%") {
          value = getEvalledConstructor("async function () {}");
        } else if (name === "%GeneratorFunction%") {
          value = getEvalledConstructor("function* () {}");
        } else if (name === "%AsyncGeneratorFunction%") {
          value = getEvalledConstructor("async function* () {}");
        } else if (name === "%AsyncGenerator%") {
          var fn = doEval2("%AsyncGeneratorFunction%");
          if (fn) {
            value = fn.prototype;
          }
        } else if (name === "%AsyncIteratorPrototype%") {
          var gen = doEval2("%AsyncGenerator%");
          if (gen && getProto) {
            value = getProto(gen.prototype);
          }
        }
        INTRINSICS[name] = value;
        return value;
      };
      var LEGACY_ALIASES = {
        __proto__: null,
        "%ArrayBufferPrototype%": ["ArrayBuffer", "prototype"],
        "%ArrayPrototype%": ["Array", "prototype"],
        "%ArrayProto_entries%": ["Array", "prototype", "entries"],
        "%ArrayProto_forEach%": ["Array", "prototype", "forEach"],
        "%ArrayProto_keys%": ["Array", "prototype", "keys"],
        "%ArrayProto_values%": ["Array", "prototype", "values"],
        "%AsyncFunctionPrototype%": ["AsyncFunction", "prototype"],
        "%AsyncGenerator%": ["AsyncGeneratorFunction", "prototype"],
        "%AsyncGeneratorPrototype%": ["AsyncGeneratorFunction", "prototype", "prototype"],
        "%BooleanPrototype%": ["Boolean", "prototype"],
        "%DataViewPrototype%": ["DataView", "prototype"],
        "%DatePrototype%": ["Date", "prototype"],
        "%ErrorPrototype%": ["Error", "prototype"],
        "%EvalErrorPrototype%": ["EvalError", "prototype"],
        "%Float32ArrayPrototype%": ["Float32Array", "prototype"],
        "%Float64ArrayPrototype%": ["Float64Array", "prototype"],
        "%FunctionPrototype%": ["Function", "prototype"],
        "%Generator%": ["GeneratorFunction", "prototype"],
        "%GeneratorPrototype%": ["GeneratorFunction", "prototype", "prototype"],
        "%Int8ArrayPrototype%": ["Int8Array", "prototype"],
        "%Int16ArrayPrototype%": ["Int16Array", "prototype"],
        "%Int32ArrayPrototype%": ["Int32Array", "prototype"],
        "%JSONParse%": ["JSON", "parse"],
        "%JSONStringify%": ["JSON", "stringify"],
        "%MapPrototype%": ["Map", "prototype"],
        "%NumberPrototype%": ["Number", "prototype"],
        "%ObjectPrototype%": ["Object", "prototype"],
        "%ObjProto_toString%": ["Object", "prototype", "toString"],
        "%ObjProto_valueOf%": ["Object", "prototype", "valueOf"],
        "%PromisePrototype%": ["Promise", "prototype"],
        "%PromiseProto_then%": ["Promise", "prototype", "then"],
        "%Promise_all%": ["Promise", "all"],
        "%Promise_reject%": ["Promise", "reject"],
        "%Promise_resolve%": ["Promise", "resolve"],
        "%RangeErrorPrototype%": ["RangeError", "prototype"],
        "%ReferenceErrorPrototype%": ["ReferenceError", "prototype"],
        "%RegExpPrototype%": ["RegExp", "prototype"],
        "%SetPrototype%": ["Set", "prototype"],
        "%SharedArrayBufferPrototype%": ["SharedArrayBuffer", "prototype"],
        "%StringPrototype%": ["String", "prototype"],
        "%SymbolPrototype%": ["Symbol", "prototype"],
        "%SyntaxErrorPrototype%": ["SyntaxError", "prototype"],
        "%TypedArrayPrototype%": ["TypedArray", "prototype"],
        "%TypeErrorPrototype%": ["TypeError", "prototype"],
        "%Uint8ArrayPrototype%": ["Uint8Array", "prototype"],
        "%Uint8ClampedArrayPrototype%": ["Uint8ClampedArray", "prototype"],
        "%Uint16ArrayPrototype%": ["Uint16Array", "prototype"],
        "%Uint32ArrayPrototype%": ["Uint32Array", "prototype"],
        "%URIErrorPrototype%": ["URIError", "prototype"],
        "%WeakMapPrototype%": ["WeakMap", "prototype"],
        "%WeakSetPrototype%": ["WeakSet", "prototype"]
      };
      var bind = require_function_bind();
      var hasOwn = require_hasown();
      var $concat = bind.call($call, Array.prototype.concat);
      var $spliceApply = bind.call($apply, Array.prototype.splice);
      var $replace = bind.call($call, String.prototype.replace);
      var $strSlice = bind.call($call, String.prototype.slice);
      var $exec = bind.call($call, RegExp.prototype.exec);
      var rePropName = /[^%.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]|(?=(?:\.|\[\])(?:\.|\[\]|%$))/g;
      var reEscapeChar = /\\(\\)?/g;
      var stringToPath = function stringToPath2(string) {
        var first = $strSlice(string, 0, 1);
        var last = $strSlice(string, -1);
        if (first === "%" && last !== "%") {
          throw new $SyntaxError("invalid intrinsic syntax, expected closing `%`");
        } else if (last === "%" && first !== "%") {
          throw new $SyntaxError("invalid intrinsic syntax, expected opening `%`");
        }
        var result = [];
        $replace(string, rePropName, function(match, number, quote, subString) {
          result[result.length] = quote ? $replace(subString, reEscapeChar, "$1") : number || match;
        });
        return result;
      };
      var getBaseIntrinsic = function getBaseIntrinsic2(name, allowMissing) {
        var intrinsicName = name;
        var alias;
        if (hasOwn(LEGACY_ALIASES, intrinsicName)) {
          alias = LEGACY_ALIASES[intrinsicName];
          intrinsicName = "%" + alias[0] + "%";
        }
        if (hasOwn(INTRINSICS, intrinsicName)) {
          var value = INTRINSICS[intrinsicName];
          if (value === needsEval) {
            value = doEval(intrinsicName);
          }
          if (typeof value === "undefined" && !allowMissing) {
            throw new $TypeError("intrinsic " + name + " exists, but is not available. Please file an issue!");
          }
          return {
            alias,
            name: intrinsicName,
            value
          };
        }
        throw new $SyntaxError("intrinsic " + name + " does not exist!");
      };
      module.exports = function GetIntrinsic(name, allowMissing) {
        if (typeof name !== "string" || name.length === 0) {
          throw new $TypeError("intrinsic name must be a non-empty string");
        }
        if (arguments.length > 1 && typeof allowMissing !== "boolean") {
          throw new $TypeError('"allowMissing" argument must be a boolean');
        }
        if ($exec(/^%?[^%]*%?$/, name) === null) {
          throw new $SyntaxError("`%` may not be present anywhere but at the beginning and end of the intrinsic name");
        }
        var parts = stringToPath(name);
        var intrinsicBaseName = parts.length > 0 ? parts[0] : "";
        var intrinsic = getBaseIntrinsic("%" + intrinsicBaseName + "%", allowMissing);
        var intrinsicRealName = intrinsic.name;
        var value = intrinsic.value;
        var skipFurtherCaching = false;
        var alias = intrinsic.alias;
        if (alias) {
          intrinsicBaseName = alias[0];
          $spliceApply(parts, $concat([0, 1], alias));
        }
        for (var i = 1, isOwn = true; i < parts.length; i += 1) {
          var part = parts[i];
          var first = $strSlice(part, 0, 1);
          var last = $strSlice(part, -1);
          if ((first === '"' || first === "'" || first === "`" || (last === '"' || last === "'" || last === "`")) && first !== last) {
            throw new $SyntaxError("property names with quotes must have matching quotes");
          }
          if (part === "constructor" || !isOwn) {
            skipFurtherCaching = true;
          }
          intrinsicBaseName += "." + part;
          intrinsicRealName = "%" + intrinsicBaseName + "%";
          if (hasOwn(INTRINSICS, intrinsicRealName)) {
            value = INTRINSICS[intrinsicRealName];
          } else if (value != null) {
            if (!(part in value)) {
              if (!allowMissing) {
                throw new $TypeError("base intrinsic for " + name + " exists, but the property is not available.");
              }
              return void undefined2;
            }
            if ($gOPD && i + 1 >= parts.length) {
              var desc = $gOPD(value, part);
              isOwn = !!desc;
              if (isOwn && "get" in desc && !("originalValue" in desc.get)) {
                value = desc.get;
              } else {
                value = value[part];
              }
            } else {
              isOwn = hasOwn(value, part);
              value = value[part];
            }
            if (isOwn && !skipFurtherCaching) {
              INTRINSICS[intrinsicRealName] = value;
            }
          }
        }
        return value;
      };
    }
  });

  // node_modules/call-bound/index.js
  var require_call_bound = __commonJS({
    "node_modules/call-bound/index.js"(exports, module) {
      "use strict";
      var GetIntrinsic = require_get_intrinsic();
      var callBindBasic = require_call_bind_apply_helpers();
      var $indexOf = callBindBasic([GetIntrinsic("%String.prototype.indexOf%")]);
      module.exports = function callBoundIntrinsic(name, allowMissing) {
        var intrinsic = (
          /** @type {(this: unknown, ...args: unknown[]) => unknown} */
          GetIntrinsic(name, !!allowMissing)
        );
        if (typeof intrinsic === "function" && $indexOf(name, ".prototype.") > -1) {
          return callBindBasic(
            /** @type {const} */
            [intrinsic]
          );
        }
        return intrinsic;
      };
    }
  });

  // node_modules/side-channel-map/index.js
  var require_side_channel_map = __commonJS({
    "node_modules/side-channel-map/index.js"(exports, module) {
      "use strict";
      var GetIntrinsic = require_get_intrinsic();
      var callBound = require_call_bound();
      var inspect = require_object_inspect();
      var $TypeError = require_type();
      var $Map = GetIntrinsic("%Map%", true);
      var $mapGet = callBound("Map.prototype.get", true);
      var $mapSet = callBound("Map.prototype.set", true);
      var $mapHas = callBound("Map.prototype.has", true);
      var $mapDelete = callBound("Map.prototype.delete", true);
      var $mapSize = callBound("Map.prototype.size", true);
      module.exports = !!$Map && /** @type {Exclude<import('.'), false>} */
      function getSideChannelMap() {
        var $m;
        var channel = {
          assert: function(key) {
            if (!channel.has(key)) {
              throw new $TypeError("Side channel does not contain " + inspect(key));
            }
          },
          "delete": function(key) {
            if ($m) {
              var result = $mapDelete($m, key);
              if ($mapSize($m) === 0) {
                $m = void 0;
              }
              return result;
            }
            return false;
          },
          get: function(key) {
            if ($m) {
              return $mapGet($m, key);
            }
          },
          has: function(key) {
            if ($m) {
              return $mapHas($m, key);
            }
            return false;
          },
          set: function(key, value) {
            if (!$m) {
              $m = new $Map();
            }
            $mapSet($m, key, value);
          }
        };
        return channel;
      };
    }
  });

  // node_modules/side-channel-weakmap/index.js
  var require_side_channel_weakmap = __commonJS({
    "node_modules/side-channel-weakmap/index.js"(exports, module) {
      "use strict";
      var GetIntrinsic = require_get_intrinsic();
      var callBound = require_call_bound();
      var inspect = require_object_inspect();
      var getSideChannelMap = require_side_channel_map();
      var $TypeError = require_type();
      var $WeakMap = GetIntrinsic("%WeakMap%", true);
      var $weakMapGet = callBound("WeakMap.prototype.get", true);
      var $weakMapSet = callBound("WeakMap.prototype.set", true);
      var $weakMapHas = callBound("WeakMap.prototype.has", true);
      var $weakMapDelete = callBound("WeakMap.prototype.delete", true);
      module.exports = $WeakMap ? (
        /** @type {Exclude<import('.'), false>} */
        function getSideChannelWeakMap() {
          var $wm;
          var $m;
          var channel = {
            assert: function(key) {
              if (!channel.has(key)) {
                throw new $TypeError("Side channel does not contain " + inspect(key));
              }
            },
            "delete": function(key) {
              if ($WeakMap && key && (typeof key === "object" || typeof key === "function")) {
                if ($wm) {
                  return $weakMapDelete($wm, key);
                }
              } else if (getSideChannelMap) {
                if ($m) {
                  return $m["delete"](key);
                }
              }
              return false;
            },
            get: function(key) {
              if ($WeakMap && key && (typeof key === "object" || typeof key === "function")) {
                if ($wm) {
                  return $weakMapGet($wm, key);
                }
              }
              return $m && $m.get(key);
            },
            has: function(key) {
              if ($WeakMap && key && (typeof key === "object" || typeof key === "function")) {
                if ($wm) {
                  return $weakMapHas($wm, key);
                }
              }
              return !!$m && $m.has(key);
            },
            set: function(key, value) {
              if ($WeakMap && key && (typeof key === "object" || typeof key === "function")) {
                if (!$wm) {
                  $wm = new $WeakMap();
                }
                $weakMapSet($wm, key, value);
              } else if (getSideChannelMap) {
                if (!$m) {
                  $m = getSideChannelMap();
                }
                $m.set(key, value);
              }
            }
          };
          return channel;
        }
      ) : getSideChannelMap;
    }
  });

  // node_modules/side-channel/index.js
  var require_side_channel = __commonJS({
    "node_modules/side-channel/index.js"(exports, module) {
      "use strict";
      var $TypeError = require_type();
      var inspect = require_object_inspect();
      var getSideChannelList = require_side_channel_list();
      var getSideChannelMap = require_side_channel_map();
      var getSideChannelWeakMap = require_side_channel_weakmap();
      var makeChannel = getSideChannelWeakMap || getSideChannelMap || getSideChannelList;
      module.exports = function getSideChannel() {
        var $channelData;
        var channel = {
          assert: function(key) {
            if (!channel.has(key)) {
              var keyDesc = key && Object(key) === key ? "the given object key" : inspect(key);
              throw new $TypeError("Side channel does not contain " + keyDesc);
            }
          },
          "delete": function(key) {
            return !!$channelData && $channelData["delete"](key);
          },
          get: function(key) {
            return $channelData && $channelData.get(key);
          },
          has: function(key) {
            return !!$channelData && $channelData.has(key);
          },
          set: function(key, value) {
            if (!$channelData) {
              $channelData = makeChannel();
            }
            $channelData.set(key, value);
          }
        };
        return channel;
      };
    }
  });

  // node_modules/qs/lib/formats.js
  var require_formats = __commonJS({
    "node_modules/qs/lib/formats.js"(exports, module) {
      "use strict";
      var replace = String.prototype.replace;
      var percentTwenties = /%20/g;
      var Format = {
        RFC1738: "RFC1738",
        RFC3986: "RFC3986"
      };
      module.exports = {
        "default": Format.RFC3986,
        formatters: {
          RFC1738: function(value) {
            return replace.call(value, percentTwenties, "+");
          },
          RFC3986: function(value) {
            return String(value);
          }
        },
        RFC1738: Format.RFC1738,
        RFC3986: Format.RFC3986
      };
    }
  });

  // node_modules/qs/lib/utils.js
  var require_utils = __commonJS({
    "node_modules/qs/lib/utils.js"(exports, module) {
      "use strict";
      var formats = require_formats();
      var getSideChannel = require_side_channel();
      var defineProperty = require_es_define_property();
      var has = Object.prototype.hasOwnProperty;
      var isArray = Array.isArray;
      var overflowChannel = getSideChannel();
      var markOverflow = function markOverflow2(obj, maxIndex) {
        overflowChannel.set(obj, maxIndex);
        return obj;
      };
      var isOverflow = function isOverflow2(obj) {
        return overflowChannel.has(obj);
      };
      var getMaxIndex = function getMaxIndex2(obj) {
        return overflowChannel.get(obj);
      };
      var setMaxIndex = function setMaxIndex2(obj, maxIndex) {
        overflowChannel.set(obj, maxIndex);
      };
      var hexTable = (function() {
        var array = [];
        for (var i = 0; i < 256; ++i) {
          array[array.length] = "%" + ((i < 16 ? "0" : "") + i.toString(16)).toUpperCase();
        }
        return array;
      })();
      var compactQueue = function compactQueue2(queue) {
        while (queue.length > 1) {
          var item = queue.pop();
          var obj = item.obj[item.prop];
          if (isArray(obj)) {
            var compacted = [];
            for (var j = 0; j < obj.length; ++j) {
              if (typeof obj[j] !== "undefined") {
                compacted[compacted.length] = obj[j];
              }
            }
            item.obj[item.prop] = compacted;
          }
        }
      };
      var arrayToObject = function arrayToObject2(source, options) {
        var obj = options && options.plainObjects ? { __proto__: null } : {};
        for (var i = 0; i < source.length; ++i) {
          if (typeof source[i] !== "undefined") {
            obj[i] = source[i];
          }
        }
        return obj;
      };
      var setProperty = function setProperty2(obj, key, value) {
        if (key === "__proto__" && defineProperty) {
          defineProperty(obj, key, {
            configurable: true,
            enumerable: true,
            value,
            writable: true
          });
        } else {
          obj[key] = value;
        }
      };
      var merge = function merge2(target, source, options) {
        if (!source) {
          return target;
        }
        if (typeof source !== "object" && typeof source !== "function") {
          if (isArray(target)) {
            var nextIndex = target.length;
            if (options && typeof options.arrayLimit === "number" && nextIndex >= options.arrayLimit) {
              if (options.throwOnLimitExceeded) {
                throw new RangeError("Array limit exceeded. Only " + options.arrayLimit + " element" + (options.arrayLimit === 1 ? "" : "s") + " allowed in an array.");
              }
              return markOverflow(arrayToObject(target.concat(source), options), nextIndex);
            }
            target[nextIndex] = source;
          } else if (target && typeof target === "object") {
            if (isOverflow(target)) {
              var newIndex = getMaxIndex(target) + 1;
              target[newIndex] = source;
              setMaxIndex(target, newIndex);
            } else if (options && options.strictMerge) {
              return [target, source];
            } else if (options && (options.plainObjects || options.allowPrototypes) || !has.call(Object.prototype, source)) {
              target[source] = true;
            }
          } else {
            return [target, source];
          }
          return target;
        }
        if (!target || typeof target !== "object") {
          if (isOverflow(source)) {
            var sourceKeys = Object.keys(source);
            var result = options && options.plainObjects ? { __proto__: null, 0: target } : { 0: target };
            for (var m = 0; m < sourceKeys.length; m++) {
              var oldKey = parseInt(sourceKeys[m], 10);
              result[oldKey + 1] = source[sourceKeys[m]];
            }
            return markOverflow(result, getMaxIndex(source) + 1);
          }
          var combined = [target].concat(source);
          if (options && typeof options.arrayLimit === "number" && combined.length > options.arrayLimit) {
            if (options.throwOnLimitExceeded) {
              throw new RangeError("Array limit exceeded. Only " + options.arrayLimit + " element" + (options.arrayLimit === 1 ? "" : "s") + " allowed in an array.");
            }
            return markOverflow(arrayToObject(combined, options), combined.length - 1);
          }
          return combined;
        }
        var mergeTarget = target;
        if (isArray(target) && !isArray(source)) {
          mergeTarget = arrayToObject(target, options);
        }
        if (isArray(target) && isArray(source)) {
          source.forEach(function(item, i) {
            if (has.call(target, i)) {
              var targetItem = target[i];
              if (targetItem && typeof targetItem === "object" && item && typeof item === "object") {
                target[i] = merge2(targetItem, item, options);
              } else {
                target[target.length] = item;
              }
            } else {
              target[i] = item;
            }
          });
          if (options && typeof options.arrayLimit === "number" && target.length > options.arrayLimit) {
            if (options.throwOnLimitExceeded) {
              throw new RangeError("Array limit exceeded. Only " + options.arrayLimit + " element" + (options.arrayLimit === 1 ? "" : "s") + " allowed in an array.");
            }
            return markOverflow(arrayToObject(target, options), target.length - 1);
          }
          return target;
        }
        return Object.keys(source).reduce(function(acc, key) {
          var value = source[key];
          if (has.call(acc, key)) {
            setProperty(acc, key, merge2(acc[key], value, options));
          } else {
            setProperty(acc, key, value);
          }
          if (isOverflow(source) && !isOverflow(acc)) {
            markOverflow(acc, getMaxIndex(source));
          }
          if (isOverflow(acc)) {
            var keyNum = parseInt(key, 10);
            if (String(keyNum) === key && keyNum >= 0 && keyNum > getMaxIndex(acc)) {
              setMaxIndex(acc, keyNum);
            }
          }
          return acc;
        }, mergeTarget);
      };
      var assign = function assignSingleSource(target, source) {
        return Object.keys(source).reduce(function(acc, key) {
          setProperty(acc, key, source[key]);
          return acc;
        }, target);
      };
      var decode = function(str, defaultDecoder, charset) {
        var strWithoutPlus = str.replace(/\+/g, " ");
        if (charset === "iso-8859-1") {
          return strWithoutPlus.replace(/%[0-9a-f]{2}/gi, unescape);
        }
        try {
          return decodeURIComponent(strWithoutPlus);
        } catch (e) {
          return strWithoutPlus;
        }
      };
      var limit = 1024;
      var encode = function encode2(str, defaultEncoder, charset, kind, format2) {
        if (str.length === 0) {
          return str;
        }
        var string = str;
        if (typeof str === "symbol") {
          string = Symbol.prototype.toString.call(str);
        } else if (typeof str !== "string") {
          string = String(str);
        }
        if (charset === "iso-8859-1") {
          return escape(string).replace(/%u[0-9a-f]{4}/gi, function($0) {
            return "%26%23" + parseInt($0.slice(2), 16) + "%3B";
          });
        }
        var out = "";
        for (var j = 0; j < string.length; j += limit) {
          var segment = string.length >= limit ? string.slice(j, j + limit) : string;
          if (j + limit < string.length) {
            var last = segment.charCodeAt(segment.length - 1);
            if (last >= 55296 && last <= 56319) {
              segment = segment.slice(0, -1);
              j -= 1;
            }
          }
          var arr = [];
          for (var i = 0; i < segment.length; ++i) {
            var c = segment.charCodeAt(i);
            if (c === 45 || c === 46 || c === 95 || c === 126 || c >= 48 && c <= 57 || c >= 65 && c <= 90 || c >= 97 && c <= 122 || format2 === formats.RFC1738 && (c === 40 || c === 41)) {
              arr[arr.length] = segment.charAt(i);
              continue;
            }
            if (c < 128) {
              arr[arr.length] = hexTable[c];
              continue;
            }
            if (c < 2048) {
              arr[arr.length] = hexTable[192 | c >> 6] + hexTable[128 | c & 63];
              continue;
            }
            if (c < 55296 || c >= 57344) {
              arr[arr.length] = hexTable[224 | c >> 12] + hexTable[128 | c >> 6 & 63] + hexTable[128 | c & 63];
              continue;
            }
            i += 1;
            c = 65536 + ((c & 1023) << 10 | segment.charCodeAt(i) & 1023);
            arr[arr.length] = hexTable[240 | c >> 18] + hexTable[128 | c >> 12 & 63] + hexTable[128 | c >> 6 & 63] + hexTable[128 | c & 63];
          }
          out += arr.join("");
        }
        return out;
      };
      var compact = function compact2(value) {
        var queue = [{ obj: { o: value }, prop: "o" }];
        var refs = getSideChannel();
        for (var i = 0; i < queue.length; ++i) {
          var item = queue[i];
          var obj = item.obj[item.prop];
          var keys = Object.keys(obj);
          for (var j = 0; j < keys.length; ++j) {
            var key = keys[j];
            var val = obj[key];
            if (typeof val === "object" && val !== null && !refs.has(val)) {
              queue[queue.length] = { obj, prop: key };
              refs.set(val, true);
            }
          }
        }
        compactQueue(queue);
        return value;
      };
      var isRegExp = function isRegExp2(obj) {
        return Object.prototype.toString.call(obj) === "[object RegExp]";
      };
      var isBuffer = function isBuffer2(obj) {
        if (!obj || typeof obj !== "object") {
          return false;
        }
        return !!(obj.constructor && typeof obj.constructor.isBuffer === "function" && obj.constructor.isBuffer(obj));
      };
      var combine = function combine2(a, b, arrayLimit, plainObjects, throwOnLimitExceeded) {
        if (isOverflow(a)) {
          if (throwOnLimitExceeded) {
            throw new RangeError("Array limit exceeded. Only " + arrayLimit + " element" + (arrayLimit === 1 ? "" : "s") + " allowed in an array.");
          }
          var bValues = isArray(b) ? b : [b];
          var newIndex = getMaxIndex(a);
          for (var i = 0; i < bValues.length; ++i) {
            newIndex += 1;
            a[newIndex] = bValues[i];
          }
          setMaxIndex(a, newIndex);
          return a;
        }
        var result = [].concat(a, b);
        if (result.length > arrayLimit) {
          if (throwOnLimitExceeded) {
            throw new RangeError("Array limit exceeded. Only " + arrayLimit + " element" + (arrayLimit === 1 ? "" : "s") + " allowed in an array.");
          }
          return markOverflow(arrayToObject(result, { plainObjects }), result.length - 1);
        }
        return result;
      };
      var maybeMap = function maybeMap2(val, fn) {
        if (isArray(val)) {
          var mapped = [];
          for (var i = 0; i < val.length; i += 1) {
            mapped[mapped.length] = fn(val[i]);
          }
          return mapped;
        }
        return fn(val);
      };
      module.exports = {
        arrayToObject,
        assign,
        combine,
        compact,
        decode,
        encode,
        isBuffer,
        isOverflow,
        isRegExp,
        markOverflow,
        maybeMap,
        merge
      };
    }
  });

  // node_modules/qs/lib/stringify.js
  var require_stringify = __commonJS({
    "node_modules/qs/lib/stringify.js"(exports, module) {
      "use strict";
      var getSideChannel = require_side_channel();
      var utils = require_utils();
      var formats = require_formats();
      var has = Object.prototype.hasOwnProperty;
      var arrayPrefixGenerators = {
        brackets: function brackets(prefix) {
          return prefix + "[]";
        },
        comma: "comma",
        indices: function indices(prefix, key) {
          return prefix + "[" + key + "]";
        },
        repeat: function repeat(prefix) {
          return prefix;
        }
      };
      var isArray = Array.isArray;
      var push = Array.prototype.push;
      var pushToArray = function(arr, valueOrArray) {
        push.apply(arr, isArray(valueOrArray) ? valueOrArray : [valueOrArray]);
      };
      var toISO = Date.prototype.toISOString;
      var defaultFormat = formats["default"];
      var defaults = {
        addQueryPrefix: false,
        allowDots: false,
        allowEmptyArrays: false,
        arrayFormat: "indices",
        charset: "utf-8",
        charsetSentinel: false,
        commaRoundTrip: false,
        delimiter: "&",
        depth: Infinity,
        encode: true,
        encodeDotInKeys: false,
        encoder: utils.encode,
        encodeValuesOnly: false,
        filter: void 0,
        format: defaultFormat,
        formatter: formats.formatters[defaultFormat],
        // deprecated
        indices: false,
        serializeDate: function serializeDate(date) {
          return toISO.call(date);
        },
        skipNulls: false,
        strictNullHandling: false
      };
      var isNonNullishPrimitive = function isNonNullishPrimitive2(v) {
        return typeof v === "string" || typeof v === "number" || typeof v === "boolean" || typeof v === "symbol" || typeof v === "bigint";
      };
      var sentinel = {};
      var stringify = function stringify2(object2, prefix, generateArrayPrefix, commaRoundTrip, allowEmptyArrays, strictNullHandling, skipNulls, encodeDotInKeys, encoder, filter, sort, allowDots, serializeDate, format2, formatter, encodeValuesOnly, charset, sideChannel, depth, currentDepth) {
        var obj = object2;
        if (currentDepth > depth) {
          throw new RangeError("Input depth exceeded depth option of " + depth);
        }
        var tmpSc = sideChannel;
        var step = 0;
        var findFlag = false;
        while ((tmpSc = tmpSc.get(sentinel)) !== void 0 && !findFlag) {
          var pos = tmpSc.get(object2);
          step += 1;
          if (typeof pos !== "undefined") {
            if (pos === step) {
              throw new RangeError("Cyclic object value");
            } else {
              findFlag = true;
            }
          }
          if (typeof tmpSc.get(sentinel) === "undefined") {
            step = 0;
          }
        }
        obj = typeof filter === "function" ? filter(prefix, obj) : obj;
        if (obj instanceof Date) {
          obj = serializeDate(obj);
        } else if (generateArrayPrefix === "comma" && isArray(obj)) {
          obj = utils.maybeMap(obj, function(value2) {
            if (value2 instanceof Date) {
              return serializeDate(value2);
            }
            return value2;
          });
        }
        if (obj === null) {
          if (strictNullHandling) {
            return formatter(encoder && !encodeValuesOnly ? encoder(prefix, defaults.encoder, charset, "key", format2) : prefix);
          }
          obj = "";
        }
        if (isNonNullishPrimitive(obj) || utils.isBuffer(obj)) {
          if (encoder) {
            var keyValue = encodeValuesOnly ? prefix : encoder(prefix, defaults.encoder, charset, "key", format2);
            return [formatter(keyValue) + "=" + formatter(encoder(obj, defaults.encoder, charset, "value", format2))];
          }
          return [formatter(prefix) + "=" + formatter(String(obj))];
        }
        var values = [];
        if (typeof obj === "undefined") {
          return values;
        }
        var objKeys;
        if (generateArrayPrefix === "comma" && isArray(obj)) {
          if (encodeValuesOnly && encoder) {
            obj = utils.maybeMap(obj, function(v) {
              return v == null ? v : encoder(v);
            });
          }
          objKeys = [{ value: obj.length > 0 ? obj.join(",") || null : void 0 }];
        } else if (isArray(filter)) {
          objKeys = filter;
        } else {
          var keys = Object.keys(obj);
          objKeys = sort ? keys.sort(sort) : keys;
        }
        var encodedPrefix = encodeDotInKeys ? String(prefix).replace(/\./g, "%2E") : String(prefix);
        var adjustedPrefix = commaRoundTrip && isArray(obj) && obj.length === 1 ? encodedPrefix + "[]" : encodedPrefix;
        if (allowEmptyArrays && isArray(obj) && obj.length === 0 && Object.keys(obj).length === 0) {
          return adjustedPrefix + "[]";
        }
        for (var j = 0; j < objKeys.length; ++j) {
          var key = objKeys[j];
          var value = typeof key === "object" && key && typeof key.value !== "undefined" ? key.value : obj[key];
          if (skipNulls && value === null) {
            continue;
          }
          var encodedKey = allowDots && encodeDotInKeys ? String(key).replace(/\./g, "%2E") : String(key);
          var keyPrefix = isArray(obj) ? typeof generateArrayPrefix === "function" ? generateArrayPrefix(adjustedPrefix, encodedKey) : adjustedPrefix : adjustedPrefix + (allowDots ? "." + encodedKey : "[" + encodedKey + "]");
          sideChannel.set(object2, step);
          var valueSideChannel = getSideChannel();
          valueSideChannel.set(sentinel, sideChannel);
          pushToArray(values, stringify2(
            value,
            keyPrefix,
            generateArrayPrefix,
            commaRoundTrip,
            allowEmptyArrays,
            strictNullHandling,
            skipNulls,
            encodeDotInKeys,
            generateArrayPrefix === "comma" && encodeValuesOnly && isArray(obj) ? null : encoder,
            filter,
            sort,
            allowDots,
            serializeDate,
            format2,
            formatter,
            encodeValuesOnly,
            charset,
            valueSideChannel,
            depth,
            currentDepth + 1
          ));
        }
        return values;
      };
      var normalizeStringifyOptions = function normalizeStringifyOptions2(opts) {
        if (!opts) {
          return defaults;
        }
        if (typeof opts.allowEmptyArrays !== "undefined" && typeof opts.allowEmptyArrays !== "boolean") {
          throw new TypeError("`allowEmptyArrays` option can only be `true` or `false`, when provided");
        }
        if (typeof opts.encodeDotInKeys !== "undefined" && typeof opts.encodeDotInKeys !== "boolean") {
          throw new TypeError("`encodeDotInKeys` option can only be `true` or `false`, when provided");
        }
        if (opts.encoder !== null && typeof opts.encoder !== "undefined" && typeof opts.encoder !== "function") {
          throw new TypeError("Encoder has to be a function.");
        }
        var charset = opts.charset || defaults.charset;
        if (typeof opts.charset !== "undefined" && opts.charset !== "utf-8" && opts.charset !== "iso-8859-1") {
          throw new TypeError("The charset option must be either utf-8, iso-8859-1, or undefined");
        }
        var format2 = formats["default"];
        if (typeof opts.format !== "undefined") {
          if (!has.call(formats.formatters, opts.format)) {
            throw new TypeError("Unknown format option provided.");
          }
          format2 = opts.format;
        }
        var formatter = formats.formatters[format2];
        var filter = defaults.filter;
        if (typeof opts.filter === "function" || isArray(opts.filter)) {
          filter = opts.filter;
        }
        var arrayFormat;
        if (opts.arrayFormat in arrayPrefixGenerators) {
          arrayFormat = opts.arrayFormat;
        } else if ("indices" in opts) {
          arrayFormat = opts.indices ? "indices" : "repeat";
        } else {
          arrayFormat = defaults.arrayFormat;
        }
        if ("commaRoundTrip" in opts && typeof opts.commaRoundTrip !== "boolean") {
          throw new TypeError("`commaRoundTrip` must be a boolean, or absent");
        }
        var allowDots = typeof opts.allowDots === "undefined" ? opts.encodeDotInKeys === true ? true : defaults.allowDots : !!opts.allowDots;
        return {
          addQueryPrefix: typeof opts.addQueryPrefix === "boolean" ? opts.addQueryPrefix : defaults.addQueryPrefix,
          allowDots,
          allowEmptyArrays: typeof opts.allowEmptyArrays === "boolean" ? !!opts.allowEmptyArrays : defaults.allowEmptyArrays,
          arrayFormat,
          charset,
          charsetSentinel: typeof opts.charsetSentinel === "boolean" ? opts.charsetSentinel : defaults.charsetSentinel,
          commaRoundTrip: !!opts.commaRoundTrip,
          delimiter: typeof opts.delimiter === "undefined" ? defaults.delimiter : opts.delimiter,
          depth: typeof opts.depth === "number" ? opts.depth : defaults.depth,
          encode: typeof opts.encode === "boolean" ? opts.encode : defaults.encode,
          encodeDotInKeys: typeof opts.encodeDotInKeys === "boolean" ? opts.encodeDotInKeys : defaults.encodeDotInKeys,
          encoder: typeof opts.encoder === "function" ? opts.encoder : defaults.encoder,
          encodeValuesOnly: typeof opts.encodeValuesOnly === "boolean" ? opts.encodeValuesOnly : defaults.encodeValuesOnly,
          filter,
          format: format2,
          formatter,
          serializeDate: typeof opts.serializeDate === "function" ? opts.serializeDate : defaults.serializeDate,
          skipNulls: typeof opts.skipNulls === "boolean" ? opts.skipNulls : defaults.skipNulls,
          sort: typeof opts.sort === "function" ? opts.sort : null,
          strictNullHandling: typeof opts.strictNullHandling === "boolean" ? opts.strictNullHandling : defaults.strictNullHandling
        };
      };
      module.exports = function(object2, opts) {
        var obj = object2;
        var options = normalizeStringifyOptions(opts);
        var objKeys;
        var filter;
        if (typeof options.filter === "function") {
          filter = options.filter;
          obj = filter("", obj);
        } else if (isArray(options.filter)) {
          filter = options.filter;
          objKeys = filter;
        }
        var keys = [];
        if (typeof obj !== "object" || obj === null) {
          return "";
        }
        var generateArrayPrefix = arrayPrefixGenerators[options.arrayFormat];
        var commaRoundTrip = generateArrayPrefix === "comma" && options.commaRoundTrip;
        if (!objKeys) {
          objKeys = Object.keys(obj);
        }
        if (options.sort) {
          objKeys.sort(options.sort);
        }
        var sideChannel = getSideChannel();
        for (var i = 0; i < objKeys.length; ++i) {
          var key = objKeys[i];
          if (typeof key === "undefined" || key === null) {
            continue;
          }
          var value = obj[key];
          if (options.skipNulls && value === null) {
            continue;
          }
          var encodedKey = options.encodeDotInKeys ? String(key).replace(/\./g, "%2E") : String(key);
          pushToArray(keys, stringify(
            value,
            encodedKey,
            generateArrayPrefix,
            commaRoundTrip,
            options.allowEmptyArrays,
            options.strictNullHandling,
            options.skipNulls,
            options.encodeDotInKeys,
            options.encode ? options.encoder : null,
            options.filter,
            options.sort,
            options.allowDots,
            options.serializeDate,
            options.format,
            options.formatter,
            options.encodeValuesOnly,
            options.charset,
            sideChannel,
            options.depth,
            0
          ));
        }
        var joined = keys.join(options.delimiter);
        var prefix = options.addQueryPrefix === true ? "?" : "";
        if (options.charsetSentinel) {
          if (options.charset === "iso-8859-1") {
            prefix += "utf8=%26%2310003%3B" + options.delimiter;
          } else {
            prefix += "utf8=%E2%9C%93" + options.delimiter;
          }
        }
        return joined.length > 0 ? prefix + joined : "";
      };
    }
  });

  // node_modules/qs/lib/parse.js
  var require_parse = __commonJS({
    "node_modules/qs/lib/parse.js"(exports, module) {
      "use strict";
      var utils = require_utils();
      var has = Object.prototype.hasOwnProperty;
      var isArray = Array.isArray;
      var defaults = {
        allowDots: false,
        allowEmptyArrays: false,
        allowPrototypes: false,
        allowSparse: false,
        arrayLimit: 20,
        charset: "utf-8",
        charsetSentinel: false,
        comma: false,
        decodeDotInKeys: false,
        decoder: utils.decode,
        delimiter: "&",
        depth: 5,
        duplicates: "combine",
        ignoreQueryPrefix: false,
        interpretNumericEntities: false,
        parameterLimit: 1e3,
        parseArrays: true,
        plainObjects: false,
        strictDepth: false,
        strictMerge: true,
        strictNullHandling: false,
        throwOnLimitExceeded: false
      };
      var interpretNumericEntities = function(str) {
        return str.replace(/&#(\d+);/g, function($0, numberStr) {
          return String.fromCharCode(parseInt(numberStr, 10));
        });
      };
      var parseArrayValue = function(val, options, currentArrayLength) {
        if (val && typeof val === "string" && options.comma && val.indexOf(",") > -1) {
          if (options.throwOnLimitExceeded) {
            var commaCount = 0;
            var commaIndex = val.indexOf(",");
            while (commaIndex > -1) {
              commaCount += 1;
              if (commaCount >= options.arrayLimit) {
                throw new RangeError("Array limit exceeded. Only " + options.arrayLimit + " element" + (options.arrayLimit === 1 ? "" : "s") + " allowed in an array.");
              }
              commaIndex = val.indexOf(",", commaIndex + 1);
            }
          }
          return val.split(",");
        }
        if (options.throwOnLimitExceeded && currentArrayLength >= options.arrayLimit) {
          throw new RangeError("Array limit exceeded. Only " + options.arrayLimit + " element" + (options.arrayLimit === 1 ? "" : "s") + " allowed in an array.");
        }
        return val;
      };
      var isoSentinel = "utf8=%26%2310003%3B";
      var charsetSentinel = "utf8=%E2%9C%93";
      var parseValues = function parseQueryStringValues(str, options) {
        var obj = { __proto__: null };
        var cleanStr = options.ignoreQueryPrefix ? str.replace(/^\?/, "") : str;
        cleanStr = cleanStr.replace(/%5B/gi, "[").replace(/%5D/gi, "]");
        var limit = options.parameterLimit === Infinity ? void 0 : options.parameterLimit;
        var parts = cleanStr.split(
          options.delimiter,
          options.throwOnLimitExceeded && typeof limit !== "undefined" ? limit + 1 : limit
        );
        if (options.throwOnLimitExceeded && typeof limit !== "undefined" && parts.length > limit) {
          throw new RangeError("Parameter limit exceeded. Only " + limit + " parameter" + (limit === 1 ? "" : "s") + " allowed.");
        }
        var skipIndex = -1;
        var i;
        var charset = options.charset;
        if (options.charsetSentinel) {
          for (i = 0; i < parts.length; ++i) {
            if (parts[i].indexOf("utf8=") === 0) {
              if (parts[i] === charsetSentinel) {
                charset = "utf-8";
              } else if (parts[i] === isoSentinel) {
                charset = "iso-8859-1";
              }
              skipIndex = i;
              i = parts.length;
            }
          }
        }
        for (i = 0; i < parts.length; ++i) {
          if (i === skipIndex) {
            continue;
          }
          var part = parts[i];
          var bracketEqualsPos = part.indexOf("]=");
          var pos = bracketEqualsPos === -1 ? part.indexOf("=") : bracketEqualsPos + 1;
          var key;
          var val;
          if (pos === -1) {
            key = options.decoder(part, defaults.decoder, charset, "key");
            val = options.strictNullHandling ? null : "";
          } else {
            key = options.decoder(part.slice(0, pos), defaults.decoder, charset, "key");
            if (key !== null) {
              val = utils.maybeMap(
                parseArrayValue(
                  part.slice(pos + 1),
                  options,
                  isArray(obj[key]) ? obj[key].length : 0
                ),
                function(encodedVal) {
                  return options.decoder(encodedVal, defaults.decoder, charset, "value");
                }
              );
            }
          }
          if (val && options.interpretNumericEntities && charset === "iso-8859-1") {
            val = interpretNumericEntities(String(val));
          }
          if (part.indexOf("[]=") > -1) {
            val = isArray(val) ? [val] : val;
          }
          if (options.comma && isArray(val) && val.length > options.arrayLimit) {
            val = utils.combine([], val, options.arrayLimit, options.plainObjects, options.throwOnLimitExceeded);
          }
          if (key !== null) {
            var existing = has.call(obj, key);
            if (existing && (options.duplicates === "combine" || part.indexOf("[]=") > -1)) {
              obj[key] = utils.combine(
                obj[key],
                val,
                options.arrayLimit,
                options.plainObjects,
                options.throwOnLimitExceeded
              );
            } else if (!existing || options.duplicates === "last") {
              obj[key] = val;
            }
          }
        }
        return obj;
      };
      var parseObject = function(chain, val, options, valuesParsed) {
        var currentArrayLength = 0;
        if (chain.length > 0 && chain[chain.length - 1] === "[]") {
          var parentKey = chain.slice(0, -1).join("");
          currentArrayLength = Array.isArray(val) && val[parentKey] ? val[parentKey].length : 0;
        }
        var leaf = valuesParsed ? val : parseArrayValue(val, options, currentArrayLength);
        for (var i = chain.length - 1; i >= 0; --i) {
          var obj;
          var root = chain[i];
          if (root === "[]" && options.parseArrays) {
            if (utils.isOverflow(leaf)) {
              obj = leaf;
            } else {
              obj = options.allowEmptyArrays && (leaf === "" || options.strictNullHandling && leaf === null) ? [] : utils.combine(
                [],
                leaf,
                options.arrayLimit,
                options.plainObjects,
                options.throwOnLimitExceeded
              );
            }
          } else {
            obj = options.plainObjects ? { __proto__: null } : {};
            var cleanRoot = root.charAt(0) === "[" && root.charAt(root.length - 1) === "]" ? root.slice(1, -1) : root;
            var decodedRoot = options.decodeDotInKeys ? cleanRoot.replace(/%2E/g, ".") : cleanRoot;
            var index = parseInt(decodedRoot, 10);
            var isValidArrayIndex = !isNaN(index) && root !== decodedRoot && String(index) === decodedRoot && index >= 0 && options.parseArrays;
            if (!options.parseArrays && decodedRoot === "") {
              obj = { 0: leaf };
            } else if (isValidArrayIndex && index < options.arrayLimit) {
              obj = [];
              obj[index] = leaf;
            } else if (isValidArrayIndex && options.throwOnLimitExceeded) {
              throw new RangeError("Array limit exceeded. Only " + options.arrayLimit + " element" + (options.arrayLimit === 1 ? "" : "s") + " allowed in an array.");
            } else if (isValidArrayIndex) {
              obj[index] = leaf;
              utils.markOverflow(obj, index);
            } else if (decodedRoot !== "__proto__") {
              obj[decodedRoot] = leaf;
            }
          }
          leaf = obj;
        }
        return leaf;
      };
      var splitKeyIntoSegments = function splitKeyIntoSegments2(originalKey, options) {
        var key = options.allowDots ? originalKey.replace(/\.([^.[]+)/g, "[$1]") : originalKey;
        if (options.depth <= 0) {
          if (!options.plainObjects && has.call(Object.prototype, key)) {
            if (!options.allowPrototypes) {
              return;
            }
          }
          return [key];
        }
        var segments = [];
        var first = key.indexOf("[");
        var parent = first >= 0 ? key.slice(0, first) : key;
        if (parent) {
          if (!options.plainObjects && has.call(Object.prototype, parent)) {
            if (!options.allowPrototypes) {
              return;
            }
          }
          segments[segments.length] = parent;
        }
        var n = key.length;
        var open = first;
        var collected = 0;
        while (open >= 0 && collected < options.depth) {
          var level = 1;
          var i = open + 1;
          var close = -1;
          while (i < n && close < 0) {
            var cu = key.charCodeAt(i);
            if (cu === 91) {
              level += 1;
            } else if (cu === 93) {
              level -= 1;
              if (level === 0) {
                close = i;
              }
            }
            i += 1;
          }
          if (close < 0) {
            segments[segments.length] = "[" + key.slice(open) + "]";
            return segments;
          }
          var seg = key.slice(open, close + 1);
          var content = seg.slice(1, -1);
          if (!options.plainObjects && has.call(Object.prototype, content) && !options.allowPrototypes) {
            return;
          }
          segments[segments.length] = seg;
          collected += 1;
          open = key.indexOf("[", close + 1);
        }
        if (open >= 0) {
          if (options.strictDepth === true) {
            throw new RangeError("Input depth exceeded depth option of " + options.depth + " and strictDepth is true");
          }
          segments[segments.length] = "[" + key.slice(open) + "]";
        }
        return segments;
      };
      var parseKeys = function parseQueryStringKeys(givenKey, val, options, valuesParsed) {
        if (!givenKey) {
          return;
        }
        var keys = splitKeyIntoSegments(givenKey, options);
        if (!keys) {
          return;
        }
        return parseObject(keys, val, options, valuesParsed);
      };
      var normalizeParseOptions = function normalizeParseOptions2(opts) {
        if (!opts) {
          return defaults;
        }
        if (typeof opts.allowEmptyArrays !== "undefined" && typeof opts.allowEmptyArrays !== "boolean") {
          throw new TypeError("`allowEmptyArrays` option can only be `true` or `false`, when provided");
        }
        if (typeof opts.decodeDotInKeys !== "undefined" && typeof opts.decodeDotInKeys !== "boolean") {
          throw new TypeError("`decodeDotInKeys` option can only be `true` or `false`, when provided");
        }
        if (opts.decoder !== null && typeof opts.decoder !== "undefined" && typeof opts.decoder !== "function") {
          throw new TypeError("Decoder has to be a function.");
        }
        if (typeof opts.charset !== "undefined" && opts.charset !== "utf-8" && opts.charset !== "iso-8859-1") {
          throw new TypeError("The charset option must be either utf-8, iso-8859-1, or undefined");
        }
        if (typeof opts.throwOnLimitExceeded !== "undefined" && typeof opts.throwOnLimitExceeded !== "boolean") {
          throw new TypeError("`throwOnLimitExceeded` option must be a boolean");
        }
        var charset = typeof opts.charset === "undefined" ? defaults.charset : opts.charset;
        var duplicates = typeof opts.duplicates === "undefined" ? defaults.duplicates : opts.duplicates;
        if (duplicates !== "combine" && duplicates !== "first" && duplicates !== "last") {
          throw new TypeError("The duplicates option must be either combine, first, or last");
        }
        var allowDots = typeof opts.allowDots === "undefined" ? opts.decodeDotInKeys === true ? true : defaults.allowDots : !!opts.allowDots;
        return {
          allowDots,
          allowEmptyArrays: typeof opts.allowEmptyArrays === "boolean" ? !!opts.allowEmptyArrays : defaults.allowEmptyArrays,
          allowPrototypes: typeof opts.allowPrototypes === "boolean" ? opts.allowPrototypes : defaults.allowPrototypes,
          allowSparse: typeof opts.allowSparse === "boolean" ? opts.allowSparse : defaults.allowSparse,
          arrayLimit: typeof opts.arrayLimit === "number" ? opts.arrayLimit : defaults.arrayLimit,
          charset,
          charsetSentinel: typeof opts.charsetSentinel === "boolean" ? opts.charsetSentinel : defaults.charsetSentinel,
          comma: typeof opts.comma === "boolean" ? opts.comma : defaults.comma,
          decodeDotInKeys: typeof opts.decodeDotInKeys === "boolean" ? opts.decodeDotInKeys : defaults.decodeDotInKeys,
          decoder: typeof opts.decoder === "function" ? opts.decoder : defaults.decoder,
          delimiter: typeof opts.delimiter === "string" || utils.isRegExp(opts.delimiter) ? opts.delimiter : defaults.delimiter,
          // eslint-disable-next-line no-implicit-coercion, no-extra-parens
          depth: typeof opts.depth === "number" || opts.depth === false ? +opts.depth : defaults.depth,
          duplicates,
          ignoreQueryPrefix: opts.ignoreQueryPrefix === true,
          interpretNumericEntities: typeof opts.interpretNumericEntities === "boolean" ? opts.interpretNumericEntities : defaults.interpretNumericEntities,
          parameterLimit: typeof opts.parameterLimit === "number" ? opts.parameterLimit : defaults.parameterLimit,
          parseArrays: opts.parseArrays !== false,
          plainObjects: typeof opts.plainObjects === "boolean" ? opts.plainObjects : defaults.plainObjects,
          strictDepth: typeof opts.strictDepth === "boolean" ? !!opts.strictDepth : defaults.strictDepth,
          strictMerge: typeof opts.strictMerge === "boolean" ? !!opts.strictMerge : defaults.strictMerge,
          strictNullHandling: typeof opts.strictNullHandling === "boolean" ? opts.strictNullHandling : defaults.strictNullHandling,
          throwOnLimitExceeded: typeof opts.throwOnLimitExceeded === "boolean" ? opts.throwOnLimitExceeded : false
        };
      };
      module.exports = function(str, opts) {
        var options = normalizeParseOptions(opts);
        if (str === "" || str === null || typeof str === "undefined") {
          return options.plainObjects ? { __proto__: null } : {};
        }
        var tempObj = typeof str === "string" ? parseValues(str, options) : str;
        var obj = options.plainObjects ? { __proto__: null } : {};
        var keys = Object.keys(tempObj);
        for (var i = 0; i < keys.length; ++i) {
          var key = keys[i];
          var newObj = parseKeys(key, tempObj[key], options, typeof str === "string");
          obj = utils.merge(obj, newObj, options);
        }
        if (options.allowSparse === true) {
          return obj;
        }
        return utils.compact(obj);
      };
    }
  });

  // node_modules/qs/lib/index.js
  var require_lib = __commonJS({
    "node_modules/qs/lib/index.js"(exports, module) {
      "use strict";
      var stringify = require_stringify();
      var parse2 = require_parse();
      var formats = require_formats();
      module.exports = {
        formats,
        parse: parse2,
        stringify
      };
    }
  });

  // node_modules/url/url.js
  var require_url = __commonJS({
    "node_modules/url/url.js"(exports) {
      "use strict";
      var punycode = require_punycode();
      function Url() {
        this.protocol = null;
        this.slashes = null;
        this.auth = null;
        this.host = null;
        this.port = null;
        this.hostname = null;
        this.hash = null;
        this.search = null;
        this.query = null;
        this.pathname = null;
        this.path = null;
        this.href = null;
      }
      var protocolPattern = /^([a-z0-9.+-]+:)/i;
      var portPattern = /:[0-9]*$/;
      var simplePathPattern = /^(\/\/?(?!\/)[^?\s]*)(\?[^\s]*)?$/;
      var delims = [
        "<",
        ">",
        '"',
        "`",
        " ",
        "\r",
        "\n",
        "	"
      ];
      var unwise = [
        "{",
        "}",
        "|",
        "\\",
        "^",
        "`"
      ].concat(delims);
      var autoEscape = ["'"].concat(unwise);
      var nonHostChars = [
        "%",
        "/",
        "?",
        ";",
        "#"
      ].concat(autoEscape);
      var hostEndingChars = [
        "/",
        "?",
        "#"
      ];
      var hostnameMaxLen = 255;
      var hostnamePartPattern = /^[+a-z0-9A-Z_-]{0,63}$/;
      var hostnamePartStart = /^([+a-z0-9A-Z_-]{0,63})(.*)$/;
      var unsafeProtocol = {
        javascript: true,
        "javascript:": true
      };
      var hostlessProtocol = {
        javascript: true,
        "javascript:": true
      };
      var slashedProtocol = {
        http: true,
        https: true,
        ftp: true,
        gopher: true,
        file: true,
        "http:": true,
        "https:": true,
        "ftp:": true,
        "gopher:": true,
        "file:": true
      };
      var querystring = require_lib();
      function urlParse(url2, parseQueryString, slashesDenoteHost) {
        if (url2 && typeof url2 === "object" && url2 instanceof Url) {
          return url2;
        }
        var u = new Url();
        u.parse(url2, parseQueryString, slashesDenoteHost);
        return u;
      }
      Url.prototype.parse = function(url2, parseQueryString, slashesDenoteHost) {
        if (typeof url2 !== "string") {
          throw new TypeError("Parameter 'url' must be a string, not " + typeof url2);
        }
        var queryIndex = url2.indexOf("?"), splitter = queryIndex !== -1 && queryIndex < url2.indexOf("#") ? "?" : "#", uSplit = url2.split(splitter), slashRegex = /\\/g;
        uSplit[0] = uSplit[0].replace(slashRegex, "/");
        url2 = uSplit.join(splitter);
        var rest = url2;
        rest = rest.trim();
        if (!slashesDenoteHost && url2.split("#").length === 1) {
          var simplePath = simplePathPattern.exec(rest);
          if (simplePath) {
            this.path = rest;
            this.href = rest;
            this.pathname = simplePath[1];
            if (simplePath[2]) {
              this.search = simplePath[2];
              if (parseQueryString) {
                this.query = querystring.parse(this.search.substr(1));
              } else {
                this.query = this.search.substr(1);
              }
            } else if (parseQueryString) {
              this.search = "";
              this.query = {};
            }
            return this;
          }
        }
        var proto = protocolPattern.exec(rest);
        if (proto) {
          proto = proto[0];
          var lowerProto = proto.toLowerCase();
          this.protocol = lowerProto;
          rest = rest.substr(proto.length);
        }
        if (slashesDenoteHost || proto || rest.match(/^\/\/[^@/]+@[^@/]+/)) {
          var slashes = rest.substr(0, 2) === "//";
          if (slashes && !(proto && hostlessProtocol[proto])) {
            rest = rest.substr(2);
            this.slashes = true;
          }
        }
        if (!hostlessProtocol[proto] && (slashes || proto && !slashedProtocol[proto])) {
          var hostEnd = -1;
          for (var i = 0; i < hostEndingChars.length; i++) {
            var hec = rest.indexOf(hostEndingChars[i]);
            if (hec !== -1 && (hostEnd === -1 || hec < hostEnd)) {
              hostEnd = hec;
            }
          }
          var auth, atSign;
          if (hostEnd === -1) {
            atSign = rest.lastIndexOf("@");
          } else {
            atSign = rest.lastIndexOf("@", hostEnd);
          }
          if (atSign !== -1) {
            auth = rest.slice(0, atSign);
            rest = rest.slice(atSign + 1);
            this.auth = decodeURIComponent(auth);
          }
          hostEnd = -1;
          for (var i = 0; i < nonHostChars.length; i++) {
            var hec = rest.indexOf(nonHostChars[i]);
            if (hec !== -1 && (hostEnd === -1 || hec < hostEnd)) {
              hostEnd = hec;
            }
          }
          if (hostEnd === -1) {
            hostEnd = rest.length;
          }
          this.host = rest.slice(0, hostEnd);
          rest = rest.slice(hostEnd);
          this.parseHost();
          this.hostname = this.hostname || "";
          var ipv6Hostname = this.hostname[0] === "[" && this.hostname[this.hostname.length - 1] === "]";
          if (!ipv6Hostname) {
            var hostparts = this.hostname.split(/\./);
            for (var i = 0, l = hostparts.length; i < l; i++) {
              var part = hostparts[i];
              if (!part) {
                continue;
              }
              if (!part.match(hostnamePartPattern)) {
                var newpart = "";
                for (var j = 0, k = part.length; j < k; j++) {
                  if (part.charCodeAt(j) > 127) {
                    newpart += "x";
                  } else {
                    newpart += part[j];
                  }
                }
                if (!newpart.match(hostnamePartPattern)) {
                  var validParts = hostparts.slice(0, i);
                  var notHost = hostparts.slice(i + 1);
                  var bit = part.match(hostnamePartStart);
                  if (bit) {
                    validParts.push(bit[1]);
                    notHost.unshift(bit[2]);
                  }
                  if (notHost.length) {
                    rest = "/" + notHost.join(".") + rest;
                  }
                  this.hostname = validParts.join(".");
                  break;
                }
              }
            }
          }
          if (this.hostname.length > hostnameMaxLen) {
            this.hostname = "";
          } else {
            this.hostname = this.hostname.toLowerCase();
          }
          if (!ipv6Hostname) {
            this.hostname = punycode.toASCII(this.hostname);
          }
          var p = this.port ? ":" + this.port : "";
          var h = this.hostname || "";
          this.host = h + p;
          this.href += this.host;
          if (ipv6Hostname) {
            this.hostname = this.hostname.substr(1, this.hostname.length - 2);
            if (rest[0] !== "/") {
              rest = "/" + rest;
            }
          }
        }
        if (!unsafeProtocol[lowerProto]) {
          for (var i = 0, l = autoEscape.length; i < l; i++) {
            var ae = autoEscape[i];
            if (rest.indexOf(ae) === -1) {
              continue;
            }
            var esc = encodeURIComponent(ae);
            if (esc === ae) {
              esc = escape(ae);
            }
            rest = rest.split(ae).join(esc);
          }
        }
        var hash = rest.indexOf("#");
        if (hash !== -1) {
          this.hash = rest.substr(hash);
          rest = rest.slice(0, hash);
        }
        var qm = rest.indexOf("?");
        if (qm !== -1) {
          this.search = rest.substr(qm);
          this.query = rest.substr(qm + 1);
          if (parseQueryString) {
            this.query = querystring.parse(this.query);
          }
          rest = rest.slice(0, qm);
        } else if (parseQueryString) {
          this.search = "";
          this.query = {};
        }
        if (rest) {
          this.pathname = rest;
        }
        if (slashedProtocol[lowerProto] && this.hostname && !this.pathname) {
          this.pathname = "/";
        }
        if (this.pathname || this.search) {
          var p = this.pathname || "";
          var s = this.search || "";
          this.path = p + s;
        }
        this.href = this.format();
        return this;
      };
      function urlFormat(obj) {
        if (typeof obj === "string") {
          obj = urlParse(obj);
        }
        if (!(obj instanceof Url)) {
          return Url.prototype.format.call(obj);
        }
        return obj.format();
      }
      Url.prototype.format = function() {
        var auth = this.auth || "";
        if (auth) {
          auth = encodeURIComponent(auth);
          auth = auth.replace(/%3A/i, ":");
          auth += "@";
        }
        var protocol = this.protocol || "", pathname = this.pathname || "", hash = this.hash || "", host = false, query = "";
        if (this.host) {
          host = auth + this.host;
        } else if (this.hostname) {
          host = auth + (this.hostname.indexOf(":") === -1 ? this.hostname : "[" + this.hostname + "]");
          if (this.port) {
            host += ":" + this.port;
          }
        }
        if (this.query && typeof this.query === "object" && Object.keys(this.query).length) {
          query = querystring.stringify(this.query, {
            arrayFormat: "repeat",
            addQueryPrefix: false
          });
        }
        var search = this.search || query && "?" + query || "";
        if (protocol && protocol.substr(-1) !== ":") {
          protocol += ":";
        }
        if (this.slashes || (!protocol || slashedProtocol[protocol]) && host !== false) {
          host = "//" + (host || "");
          if (pathname && pathname.charAt(0) !== "/") {
            pathname = "/" + pathname;
          }
        } else if (!host) {
          host = "";
        }
        if (hash && hash.charAt(0) !== "#") {
          hash = "#" + hash;
        }
        if (search && search.charAt(0) !== "?") {
          search = "?" + search;
        }
        pathname = pathname.replace(/[?#]/g, function(match) {
          return encodeURIComponent(match);
        });
        search = search.replace("#", "%23");
        return protocol + host + pathname + search + hash;
      };
      function urlResolve(source, relative) {
        return urlParse(source, false, true).resolve(relative);
      }
      Url.prototype.resolve = function(relative) {
        return this.resolveObject(urlParse(relative, false, true)).format();
      };
      function urlResolveObject(source, relative) {
        if (!source) {
          return relative;
        }
        return urlParse(source, false, true).resolveObject(relative);
      }
      Url.prototype.resolveObject = function(relative) {
        if (typeof relative === "string") {
          var rel = new Url();
          rel.parse(relative, false, true);
          relative = rel;
        }
        var result = new Url();
        var tkeys = Object.keys(this);
        for (var tk = 0; tk < tkeys.length; tk++) {
          var tkey = tkeys[tk];
          result[tkey] = this[tkey];
        }
        result.hash = relative.hash;
        if (relative.href === "") {
          result.href = result.format();
          return result;
        }
        if (relative.slashes && !relative.protocol) {
          var rkeys = Object.keys(relative);
          for (var rk = 0; rk < rkeys.length; rk++) {
            var rkey = rkeys[rk];
            if (rkey !== "protocol") {
              result[rkey] = relative[rkey];
            }
          }
          if (slashedProtocol[result.protocol] && result.hostname && !result.pathname) {
            result.pathname = "/";
            result.path = result.pathname;
          }
          result.href = result.format();
          return result;
        }
        if (relative.protocol && relative.protocol !== result.protocol) {
          if (!slashedProtocol[relative.protocol]) {
            var keys = Object.keys(relative);
            for (var v = 0; v < keys.length; v++) {
              var k = keys[v];
              result[k] = relative[k];
            }
            result.href = result.format();
            return result;
          }
          result.protocol = relative.protocol;
          if (!relative.host && !hostlessProtocol[relative.protocol]) {
            var relPath = (relative.pathname || "").split("/");
            while (relPath.length && !(relative.host = relPath.shift())) {
            }
            if (!relative.host) {
              relative.host = "";
            }
            if (!relative.hostname) {
              relative.hostname = "";
            }
            if (relPath[0] !== "") {
              relPath.unshift("");
            }
            if (relPath.length < 2) {
              relPath.unshift("");
            }
            result.pathname = relPath.join("/");
          } else {
            result.pathname = relative.pathname;
          }
          result.search = relative.search;
          result.query = relative.query;
          result.host = relative.host || "";
          result.auth = relative.auth;
          result.hostname = relative.hostname || relative.host;
          result.port = relative.port;
          if (result.pathname || result.search) {
            var p = result.pathname || "";
            var s = result.search || "";
            result.path = p + s;
          }
          result.slashes = result.slashes || relative.slashes;
          result.href = result.format();
          return result;
        }
        var isSourceAbs = result.pathname && result.pathname.charAt(0) === "/", isRelAbs = relative.host || relative.pathname && relative.pathname.charAt(0) === "/", mustEndAbs = isRelAbs || isSourceAbs || result.host && relative.pathname, removeAllDots = mustEndAbs, srcPath = result.pathname && result.pathname.split("/") || [], relPath = relative.pathname && relative.pathname.split("/") || [], psychotic = result.protocol && !slashedProtocol[result.protocol];
        if (psychotic) {
          result.hostname = "";
          result.port = null;
          if (result.host) {
            if (srcPath[0] === "") {
              srcPath[0] = result.host;
            } else {
              srcPath.unshift(result.host);
            }
          }
          result.host = "";
          if (relative.protocol) {
            relative.hostname = null;
            relative.port = null;
            if (relative.host) {
              if (relPath[0] === "") {
                relPath[0] = relative.host;
              } else {
                relPath.unshift(relative.host);
              }
            }
            relative.host = null;
          }
          mustEndAbs = mustEndAbs && (relPath[0] === "" || srcPath[0] === "");
        }
        if (isRelAbs) {
          result.host = relative.host || relative.host === "" ? relative.host : result.host;
          result.hostname = relative.hostname || relative.hostname === "" ? relative.hostname : result.hostname;
          result.search = relative.search;
          result.query = relative.query;
          srcPath = relPath;
        } else if (relPath.length) {
          if (!srcPath) {
            srcPath = [];
          }
          srcPath.pop();
          srcPath = srcPath.concat(relPath);
          result.search = relative.search;
          result.query = relative.query;
        } else if (relative.search != null) {
          if (psychotic) {
            result.host = srcPath.shift();
            result.hostname = result.host;
            var authInHost = result.host && result.host.indexOf("@") > 0 ? result.host.split("@") : false;
            if (authInHost) {
              result.auth = authInHost.shift();
              result.hostname = authInHost.shift();
              result.host = result.hostname;
            }
          }
          result.search = relative.search;
          result.query = relative.query;
          if (result.pathname !== null || result.search !== null) {
            result.path = (result.pathname ? result.pathname : "") + (result.search ? result.search : "");
          }
          result.href = result.format();
          return result;
        }
        if (!srcPath.length) {
          result.pathname = null;
          if (result.search) {
            result.path = "/" + result.search;
          } else {
            result.path = null;
          }
          result.href = result.format();
          return result;
        }
        var last = srcPath.slice(-1)[0];
        var hasTrailingSlash = (result.host || relative.host || srcPath.length > 1) && (last === "." || last === "..") || last === "";
        var up = 0;
        for (var i = srcPath.length; i >= 0; i--) {
          last = srcPath[i];
          if (last === ".") {
            srcPath.splice(i, 1);
          } else if (last === "..") {
            srcPath.splice(i, 1);
            up++;
          } else if (up) {
            srcPath.splice(i, 1);
            up--;
          }
        }
        if (!mustEndAbs && !removeAllDots) {
          for (; up--; up) {
            srcPath.unshift("..");
          }
        }
        if (mustEndAbs && srcPath[0] !== "" && (!srcPath[0] || srcPath[0].charAt(0) !== "/")) {
          srcPath.unshift("");
        }
        if (hasTrailingSlash && srcPath.join("/").substr(-1) !== "/") {
          srcPath.push("");
        }
        var isAbsolute = srcPath[0] === "" || srcPath[0] && srcPath[0].charAt(0) === "/";
        if (psychotic) {
          result.hostname = isAbsolute ? "" : srcPath.length ? srcPath.shift() : "";
          result.host = result.hostname;
          var authInHost = result.host && result.host.indexOf("@") > 0 ? result.host.split("@") : false;
          if (authInHost) {
            result.auth = authInHost.shift();
            result.hostname = authInHost.shift();
            result.host = result.hostname;
          }
        }
        mustEndAbs = mustEndAbs || result.host && srcPath.length;
        if (mustEndAbs && !isAbsolute) {
          srcPath.unshift("");
        }
        if (srcPath.length > 0) {
          result.pathname = srcPath.join("/");
        } else {
          result.pathname = null;
          result.path = null;
        }
        if (result.pathname !== null || result.search !== null) {
          result.path = (result.pathname ? result.pathname : "") + (result.search ? result.search : "");
        }
        result.auth = relative.auth || result.auth;
        result.slashes = result.slashes || relative.slashes;
        result.href = result.format();
        return result;
      };
      Url.prototype.parseHost = function() {
        var host = this.host;
        var port = portPattern.exec(host);
        if (port) {
          port = port[0];
          if (port !== ":") {
            this.port = port.substr(1);
          }
          host = host.substr(0, host.length - port.length);
        }
        if (host) {
          this.hostname = host;
        }
      };
      exports.parse = urlParse;
      exports.resolve = urlResolve;
      exports.resolveObject = urlResolveObject;
      exports.format = urlFormat;
      exports.Url = Url;
    }
  });

  // node_modules/jszip/dist/jszip.min.js
  var require_jszip_min = __commonJS({
    "node_modules/jszip/dist/jszip.min.js"(exports, module) {
      !(function(e) {
        if ("object" == typeof exports && "undefined" != typeof module) module.exports = e();
        else if ("function" == typeof define && define.amd) define([], e);
        else {
          ("undefined" != typeof window ? window : "undefined" != typeof global ? global : "undefined" != typeof self ? self : this).JSZip = e();
        }
      })(function() {
        return (function s(a, o, h) {
          function u(r, e2) {
            if (!o[r]) {
              if (!a[r]) {
                var t = "function" == typeof __require && __require;
                if (!e2 && t) return t(r, true);
                if (l) return l(r, true);
                var n = new Error("Cannot find module '" + r + "'");
                throw n.code = "MODULE_NOT_FOUND", n;
              }
              var i = o[r] = { exports: {} };
              a[r][0].call(i.exports, function(e3) {
                var t2 = a[r][1][e3];
                return u(t2 || e3);
              }, i, i.exports, s, a, o, h);
            }
            return o[r].exports;
          }
          for (var l = "function" == typeof __require && __require, e = 0; e < h.length; e++) u(h[e]);
          return u;
        })({ 1: [function(e, t, r) {
          "use strict";
          var d = e("./utils"), c = e("./support"), p = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
          r.encode = function(e2) {
            for (var t2, r2, n, i, s, a, o, h = [], u = 0, l = e2.length, f = l, c2 = "string" !== d.getTypeOf(e2); u < e2.length; ) f = l - u, n = c2 ? (t2 = e2[u++], r2 = u < l ? e2[u++] : 0, u < l ? e2[u++] : 0) : (t2 = e2.charCodeAt(u++), r2 = u < l ? e2.charCodeAt(u++) : 0, u < l ? e2.charCodeAt(u++) : 0), i = t2 >> 2, s = (3 & t2) << 4 | r2 >> 4, a = 1 < f ? (15 & r2) << 2 | n >> 6 : 64, o = 2 < f ? 63 & n : 64, h.push(p.charAt(i) + p.charAt(s) + p.charAt(a) + p.charAt(o));
            return h.join("");
          }, r.decode = function(e2) {
            var t2, r2, n, i, s, a, o = 0, h = 0, u = "data:";
            if (e2.substr(0, u.length) === u) throw new Error("Invalid base64 input, it looks like a data url.");
            var l, f = 3 * (e2 = e2.replace(/[^A-Za-z0-9+/=]/g, "")).length / 4;
            if (e2.charAt(e2.length - 1) === p.charAt(64) && f--, e2.charAt(e2.length - 2) === p.charAt(64) && f--, f % 1 != 0) throw new Error("Invalid base64 input, bad content length.");
            for (l = c.uint8array ? new Uint8Array(0 | f) : new Array(0 | f); o < e2.length; ) t2 = p.indexOf(e2.charAt(o++)) << 2 | (i = p.indexOf(e2.charAt(o++))) >> 4, r2 = (15 & i) << 4 | (s = p.indexOf(e2.charAt(o++))) >> 2, n = (3 & s) << 6 | (a = p.indexOf(e2.charAt(o++))), l[h++] = t2, 64 !== s && (l[h++] = r2), 64 !== a && (l[h++] = n);
            return l;
          };
        }, { "./support": 30, "./utils": 32 }], 2: [function(e, t, r) {
          "use strict";
          var n = e("./external"), i = e("./stream/DataWorker"), s = e("./stream/Crc32Probe"), a = e("./stream/DataLengthProbe");
          function o(e2, t2, r2, n2, i2) {
            this.compressedSize = e2, this.uncompressedSize = t2, this.crc32 = r2, this.compression = n2, this.compressedContent = i2;
          }
          o.prototype = { getContentWorker: function() {
            var e2 = new i(n.Promise.resolve(this.compressedContent)).pipe(this.compression.uncompressWorker()).pipe(new a("data_length")), t2 = this;
            return e2.on("end", function() {
              if (this.streamInfo.data_length !== t2.uncompressedSize) throw new Error("Bug : uncompressed data size mismatch");
            }), e2;
          }, getCompressedWorker: function() {
            return new i(n.Promise.resolve(this.compressedContent)).withStreamInfo("compressedSize", this.compressedSize).withStreamInfo("uncompressedSize", this.uncompressedSize).withStreamInfo("crc32", this.crc32).withStreamInfo("compression", this.compression);
          } }, o.createWorkerFrom = function(e2, t2, r2) {
            return e2.pipe(new s()).pipe(new a("uncompressedSize")).pipe(t2.compressWorker(r2)).pipe(new a("compressedSize")).withStreamInfo("compression", t2);
          }, t.exports = o;
        }, { "./external": 6, "./stream/Crc32Probe": 25, "./stream/DataLengthProbe": 26, "./stream/DataWorker": 27 }], 3: [function(e, t, r) {
          "use strict";
          var n = e("./stream/GenericWorker");
          r.STORE = { magic: "\0\0", compressWorker: function() {
            return new n("STORE compression");
          }, uncompressWorker: function() {
            return new n("STORE decompression");
          } }, r.DEFLATE = e("./flate");
        }, { "./flate": 7, "./stream/GenericWorker": 28 }], 4: [function(e, t, r) {
          "use strict";
          var n = e("./utils");
          var o = (function() {
            for (var e2, t2 = [], r2 = 0; r2 < 256; r2++) {
              e2 = r2;
              for (var n2 = 0; n2 < 8; n2++) e2 = 1 & e2 ? 3988292384 ^ e2 >>> 1 : e2 >>> 1;
              t2[r2] = e2;
            }
            return t2;
          })();
          t.exports = function(e2, t2) {
            return void 0 !== e2 && e2.length ? "string" !== n.getTypeOf(e2) ? (function(e3, t3, r2, n2) {
              var i = o, s = n2 + r2;
              e3 ^= -1;
              for (var a = n2; a < s; a++) e3 = e3 >>> 8 ^ i[255 & (e3 ^ t3[a])];
              return -1 ^ e3;
            })(0 | t2, e2, e2.length, 0) : (function(e3, t3, r2, n2) {
              var i = o, s = n2 + r2;
              e3 ^= -1;
              for (var a = n2; a < s; a++) e3 = e3 >>> 8 ^ i[255 & (e3 ^ t3.charCodeAt(a))];
              return -1 ^ e3;
            })(0 | t2, e2, e2.length, 0) : 0;
          };
        }, { "./utils": 32 }], 5: [function(e, t, r) {
          "use strict";
          r.base64 = false, r.binary = false, r.dir = false, r.createFolders = true, r.date = null, r.compression = null, r.compressionOptions = null, r.comment = null, r.unixPermissions = null, r.dosPermissions = null;
        }, {}], 6: [function(e, t, r) {
          "use strict";
          var n = null;
          n = "undefined" != typeof Promise ? Promise : e("lie"), t.exports = { Promise: n };
        }, { lie: 37 }], 7: [function(e, t, r) {
          "use strict";
          var n = "undefined" != typeof Uint8Array && "undefined" != typeof Uint16Array && "undefined" != typeof Uint32Array, i = e("pako"), s = e("./utils"), a = e("./stream/GenericWorker"), o = n ? "uint8array" : "array";
          function h(e2, t2) {
            a.call(this, "FlateWorker/" + e2), this._pako = null, this._pakoAction = e2, this._pakoOptions = t2, this.meta = {};
          }
          r.magic = "\b\0", s.inherits(h, a), h.prototype.processChunk = function(e2) {
            this.meta = e2.meta, null === this._pako && this._createPako(), this._pako.push(s.transformTo(o, e2.data), false);
          }, h.prototype.flush = function() {
            a.prototype.flush.call(this), null === this._pako && this._createPako(), this._pako.push([], true);
          }, h.prototype.cleanUp = function() {
            a.prototype.cleanUp.call(this), this._pako = null;
          }, h.prototype._createPako = function() {
            this._pako = new i[this._pakoAction]({ raw: true, level: this._pakoOptions.level || -1 });
            var t2 = this;
            this._pako.onData = function(e2) {
              t2.push({ data: e2, meta: t2.meta });
            };
          }, r.compressWorker = function(e2) {
            return new h("Deflate", e2);
          }, r.uncompressWorker = function() {
            return new h("Inflate", {});
          };
        }, { "./stream/GenericWorker": 28, "./utils": 32, pako: 38 }], 8: [function(e, t, r) {
          "use strict";
          function A(e2, t2) {
            var r2, n2 = "";
            for (r2 = 0; r2 < t2; r2++) n2 += String.fromCharCode(255 & e2), e2 >>>= 8;
            return n2;
          }
          function n(e2, t2, r2, n2, i2, s2) {
            var a, o, h = e2.file, u = e2.compression, l = s2 !== O.utf8encode, f = I.transformTo("string", s2(h.name)), c = I.transformTo("string", O.utf8encode(h.name)), d = h.comment, p = I.transformTo("string", s2(d)), m = I.transformTo("string", O.utf8encode(d)), _ = c.length !== h.name.length, g = m.length !== d.length, b = "", v = "", y = "", w = h.dir, k = h.date, x = { crc32: 0, compressedSize: 0, uncompressedSize: 0 };
            t2 && !r2 || (x.crc32 = e2.crc32, x.compressedSize = e2.compressedSize, x.uncompressedSize = e2.uncompressedSize);
            var S = 0;
            t2 && (S |= 8), l || !_ && !g || (S |= 2048);
            var z = 0, C = 0;
            w && (z |= 16), "UNIX" === i2 ? (C = 798, z |= (function(e3, t3) {
              var r3 = e3;
              return e3 || (r3 = t3 ? 16893 : 33204), (65535 & r3) << 16;
            })(h.unixPermissions, w)) : (C = 20, z |= (function(e3) {
              return 63 & (e3 || 0);
            })(h.dosPermissions)), a = k.getUTCHours(), a <<= 6, a |= k.getUTCMinutes(), a <<= 5, a |= k.getUTCSeconds() / 2, o = k.getUTCFullYear() - 1980, o <<= 4, o |= k.getUTCMonth() + 1, o <<= 5, o |= k.getUTCDate(), _ && (v = A(1, 1) + A(B(f), 4) + c, b += "up" + A(v.length, 2) + v), g && (y = A(1, 1) + A(B(p), 4) + m, b += "uc" + A(y.length, 2) + y);
            var E = "";
            return E += "\n\0", E += A(S, 2), E += u.magic, E += A(a, 2), E += A(o, 2), E += A(x.crc32, 4), E += A(x.compressedSize, 4), E += A(x.uncompressedSize, 4), E += A(f.length, 2), E += A(b.length, 2), { fileRecord: R.LOCAL_FILE_HEADER + E + f + b, dirRecord: R.CENTRAL_FILE_HEADER + A(C, 2) + E + A(p.length, 2) + "\0\0\0\0" + A(z, 4) + A(n2, 4) + f + b + p };
          }
          var I = e("../utils"), i = e("../stream/GenericWorker"), O = e("../utf8"), B = e("../crc32"), R = e("../signature");
          function s(e2, t2, r2, n2) {
            i.call(this, "ZipFileWorker"), this.bytesWritten = 0, this.zipComment = t2, this.zipPlatform = r2, this.encodeFileName = n2, this.streamFiles = e2, this.accumulate = false, this.contentBuffer = [], this.dirRecords = [], this.currentSourceOffset = 0, this.entriesCount = 0, this.currentFile = null, this._sources = [];
          }
          I.inherits(s, i), s.prototype.push = function(e2) {
            var t2 = e2.meta.percent || 0, r2 = this.entriesCount, n2 = this._sources.length;
            this.accumulate ? this.contentBuffer.push(e2) : (this.bytesWritten += e2.data.length, i.prototype.push.call(this, { data: e2.data, meta: { currentFile: this.currentFile, percent: r2 ? (t2 + 100 * (r2 - n2 - 1)) / r2 : 100 } }));
          }, s.prototype.openedSource = function(e2) {
            this.currentSourceOffset = this.bytesWritten, this.currentFile = e2.file.name;
            var t2 = this.streamFiles && !e2.file.dir;
            if (t2) {
              var r2 = n(e2, t2, false, this.currentSourceOffset, this.zipPlatform, this.encodeFileName);
              this.push({ data: r2.fileRecord, meta: { percent: 0 } });
            } else this.accumulate = true;
          }, s.prototype.closedSource = function(e2) {
            this.accumulate = false;
            var t2 = this.streamFiles && !e2.file.dir, r2 = n(e2, t2, true, this.currentSourceOffset, this.zipPlatform, this.encodeFileName);
            if (this.dirRecords.push(r2.dirRecord), t2) this.push({ data: (function(e3) {
              return R.DATA_DESCRIPTOR + A(e3.crc32, 4) + A(e3.compressedSize, 4) + A(e3.uncompressedSize, 4);
            })(e2), meta: { percent: 100 } });
            else for (this.push({ data: r2.fileRecord, meta: { percent: 0 } }); this.contentBuffer.length; ) this.push(this.contentBuffer.shift());
            this.currentFile = null;
          }, s.prototype.flush = function() {
            for (var e2 = this.bytesWritten, t2 = 0; t2 < this.dirRecords.length; t2++) this.push({ data: this.dirRecords[t2], meta: { percent: 100 } });
            var r2 = this.bytesWritten - e2, n2 = (function(e3, t3, r3, n3, i2) {
              var s2 = I.transformTo("string", i2(n3));
              return R.CENTRAL_DIRECTORY_END + "\0\0\0\0" + A(e3, 2) + A(e3, 2) + A(t3, 4) + A(r3, 4) + A(s2.length, 2) + s2;
            })(this.dirRecords.length, r2, e2, this.zipComment, this.encodeFileName);
            this.push({ data: n2, meta: { percent: 100 } });
          }, s.prototype.prepareNextSource = function() {
            this.previous = this._sources.shift(), this.openedSource(this.previous.streamInfo), this.isPaused ? this.previous.pause() : this.previous.resume();
          }, s.prototype.registerPrevious = function(e2) {
            this._sources.push(e2);
            var t2 = this;
            return e2.on("data", function(e3) {
              t2.processChunk(e3);
            }), e2.on("end", function() {
              t2.closedSource(t2.previous.streamInfo), t2._sources.length ? t2.prepareNextSource() : t2.end();
            }), e2.on("error", function(e3) {
              t2.error(e3);
            }), this;
          }, s.prototype.resume = function() {
            return !!i.prototype.resume.call(this) && (!this.previous && this._sources.length ? (this.prepareNextSource(), true) : this.previous || this._sources.length || this.generatedError ? void 0 : (this.end(), true));
          }, s.prototype.error = function(e2) {
            var t2 = this._sources;
            if (!i.prototype.error.call(this, e2)) return false;
            for (var r2 = 0; r2 < t2.length; r2++) try {
              t2[r2].error(e2);
            } catch (e3) {
            }
            return true;
          }, s.prototype.lock = function() {
            i.prototype.lock.call(this);
            for (var e2 = this._sources, t2 = 0; t2 < e2.length; t2++) e2[t2].lock();
          }, t.exports = s;
        }, { "../crc32": 4, "../signature": 23, "../stream/GenericWorker": 28, "../utf8": 31, "../utils": 32 }], 9: [function(e, t, r) {
          "use strict";
          var u = e("../compressions"), n = e("./ZipFileWorker");
          r.generateWorker = function(e2, a, t2) {
            var o = new n(a.streamFiles, t2, a.platform, a.encodeFileName), h = 0;
            try {
              e2.forEach(function(e3, t3) {
                h++;
                var r2 = (function(e4, t4) {
                  var r3 = e4 || t4, n3 = u[r3];
                  if (!n3) throw new Error(r3 + " is not a valid compression method !");
                  return n3;
                })(t3.options.compression, a.compression), n2 = t3.options.compressionOptions || a.compressionOptions || {}, i = t3.dir, s = t3.date;
                t3._compressWorker(r2, n2).withStreamInfo("file", { name: e3, dir: i, date: s, comment: t3.comment || "", unixPermissions: t3.unixPermissions, dosPermissions: t3.dosPermissions }).pipe(o);
              }), o.entriesCount = h;
            } catch (e3) {
              o.error(e3);
            }
            return o;
          };
        }, { "../compressions": 3, "./ZipFileWorker": 8 }], 10: [function(e, t, r) {
          "use strict";
          function n() {
            if (!(this instanceof n)) return new n();
            if (arguments.length) throw new Error("The constructor with parameters has been removed in JSZip 3.0, please check the upgrade guide.");
            this.files = /* @__PURE__ */ Object.create(null), this.comment = null, this.root = "", this.clone = function() {
              var e2 = new n();
              for (var t2 in this) "function" != typeof this[t2] && (e2[t2] = this[t2]);
              return e2;
            };
          }
          (n.prototype = e("./object")).loadAsync = e("./load"), n.support = e("./support"), n.defaults = e("./defaults"), n.version = "3.10.1", n.loadAsync = function(e2, t2) {
            return new n().loadAsync(e2, t2);
          }, n.external = e("./external"), t.exports = n;
        }, { "./defaults": 5, "./external": 6, "./load": 11, "./object": 15, "./support": 30 }], 11: [function(e, t, r) {
          "use strict";
          var u = e("./utils"), i = e("./external"), n = e("./utf8"), s = e("./zipEntries"), a = e("./stream/Crc32Probe"), l = e("./nodejsUtils");
          function f(n2) {
            return new i.Promise(function(e2, t2) {
              var r2 = n2.decompressed.getContentWorker().pipe(new a());
              r2.on("error", function(e3) {
                t2(e3);
              }).on("end", function() {
                r2.streamInfo.crc32 !== n2.decompressed.crc32 ? t2(new Error("Corrupted zip : CRC32 mismatch")) : e2();
              }).resume();
            });
          }
          t.exports = function(e2, o) {
            var h = this;
            return o = u.extend(o || {}, { base64: false, checkCRC32: false, optimizedBinaryString: false, createFolders: false, decodeFileName: n.utf8decode }), l.isNode && l.isStream(e2) ? i.Promise.reject(new Error("JSZip can't accept a stream when loading a zip file.")) : u.prepareContent("the loaded zip file", e2, true, o.optimizedBinaryString, o.base64).then(function(e3) {
              var t2 = new s(o);
              return t2.load(e3), t2;
            }).then(function(e3) {
              var t2 = [i.Promise.resolve(e3)], r2 = e3.files;
              if (o.checkCRC32) for (var n2 = 0; n2 < r2.length; n2++) t2.push(f(r2[n2]));
              return i.Promise.all(t2);
            }).then(function(e3) {
              for (var t2 = e3.shift(), r2 = t2.files, n2 = 0; n2 < r2.length; n2++) {
                var i2 = r2[n2], s2 = i2.fileNameStr, a2 = u.resolve(i2.fileNameStr);
                h.file(a2, i2.decompressed, { binary: true, optimizedBinaryString: true, date: i2.date, dir: i2.dir, comment: i2.fileCommentStr.length ? i2.fileCommentStr : null, unixPermissions: i2.unixPermissions, dosPermissions: i2.dosPermissions, createFolders: o.createFolders }), i2.dir || (h.file(a2).unsafeOriginalName = s2);
              }
              return t2.zipComment.length && (h.comment = t2.zipComment), h;
            });
          };
        }, { "./external": 6, "./nodejsUtils": 14, "./stream/Crc32Probe": 25, "./utf8": 31, "./utils": 32, "./zipEntries": 33 }], 12: [function(e, t, r) {
          "use strict";
          var n = e("../utils"), i = e("../stream/GenericWorker");
          function s(e2, t2) {
            i.call(this, "Nodejs stream input adapter for " + e2), this._upstreamEnded = false, this._bindStream(t2);
          }
          n.inherits(s, i), s.prototype._bindStream = function(e2) {
            var t2 = this;
            (this._stream = e2).pause(), e2.on("data", function(e3) {
              t2.push({ data: e3, meta: { percent: 0 } });
            }).on("error", function(e3) {
              t2.isPaused ? this.generatedError = e3 : t2.error(e3);
            }).on("end", function() {
              t2.isPaused ? t2._upstreamEnded = true : t2.end();
            });
          }, s.prototype.pause = function() {
            return !!i.prototype.pause.call(this) && (this._stream.pause(), true);
          }, s.prototype.resume = function() {
            return !!i.prototype.resume.call(this) && (this._upstreamEnded ? this.end() : this._stream.resume(), true);
          }, t.exports = s;
        }, { "../stream/GenericWorker": 28, "../utils": 32 }], 13: [function(e, t, r) {
          "use strict";
          var i = e("readable-stream").Readable;
          function n(e2, t2, r2) {
            i.call(this, t2), this._helper = e2;
            var n2 = this;
            e2.on("data", function(e3, t3) {
              n2.push(e3) || n2._helper.pause(), r2 && r2(t3);
            }).on("error", function(e3) {
              n2.emit("error", e3);
            }).on("end", function() {
              n2.push(null);
            });
          }
          e("../utils").inherits(n, i), n.prototype._read = function() {
            this._helper.resume();
          }, t.exports = n;
        }, { "../utils": 32, "readable-stream": 16 }], 14: [function(e, t, r) {
          "use strict";
          t.exports = { isNode: "undefined" != typeof Buffer, newBufferFrom: function(e2, t2) {
            if (Buffer.from && Buffer.from !== Uint8Array.from) return Buffer.from(e2, t2);
            if ("number" == typeof e2) throw new Error('The "data" argument must not be a number');
            return new Buffer(e2, t2);
          }, allocBuffer: function(e2) {
            if (Buffer.alloc) return Buffer.alloc(e2);
            var t2 = new Buffer(e2);
            return t2.fill(0), t2;
          }, isBuffer: function(e2) {
            return Buffer.isBuffer(e2);
          }, isStream: function(e2) {
            return e2 && "function" == typeof e2.on && "function" == typeof e2.pause && "function" == typeof e2.resume;
          } };
        }, {}], 15: [function(e, t, r) {
          "use strict";
          function s(e2, t2, r2) {
            var n2, i2 = u.getTypeOf(t2), s2 = u.extend(r2 || {}, f);
            s2.date = s2.date || /* @__PURE__ */ new Date(), null !== s2.compression && (s2.compression = s2.compression.toUpperCase()), "string" == typeof s2.unixPermissions && (s2.unixPermissions = parseInt(s2.unixPermissions, 8)), s2.unixPermissions && 16384 & s2.unixPermissions && (s2.dir = true), s2.dosPermissions && 16 & s2.dosPermissions && (s2.dir = true), s2.dir && (e2 = g(e2)), s2.createFolders && (n2 = _(e2)) && b.call(this, n2, true);
            var a2 = "string" === i2 && false === s2.binary && false === s2.base64;
            r2 && void 0 !== r2.binary || (s2.binary = !a2), (t2 instanceof c && 0 === t2.uncompressedSize || s2.dir || !t2 || 0 === t2.length) && (s2.base64 = false, s2.binary = true, t2 = "", s2.compression = "STORE", i2 = "string");
            var o2 = null;
            o2 = t2 instanceof c || t2 instanceof l ? t2 : p.isNode && p.isStream(t2) ? new m(e2, t2) : u.prepareContent(e2, t2, s2.binary, s2.optimizedBinaryString, s2.base64);
            var h2 = new d(e2, o2, s2);
            this.files[e2] = h2;
          }
          var i = e("./utf8"), u = e("./utils"), l = e("./stream/GenericWorker"), a = e("./stream/StreamHelper"), f = e("./defaults"), c = e("./compressedObject"), d = e("./zipObject"), o = e("./generate"), p = e("./nodejsUtils"), m = e("./nodejs/NodejsStreamInputAdapter"), _ = function(e2) {
            "/" === e2.slice(-1) && (e2 = e2.substring(0, e2.length - 1));
            var t2 = e2.lastIndexOf("/");
            return 0 < t2 ? e2.substring(0, t2) : "";
          }, g = function(e2) {
            return "/" !== e2.slice(-1) && (e2 += "/"), e2;
          }, b = function(e2, t2) {
            return t2 = void 0 !== t2 ? t2 : f.createFolders, e2 = g(e2), this.files[e2] || s.call(this, e2, null, { dir: true, createFolders: t2 }), this.files[e2];
          };
          function h(e2) {
            return "[object RegExp]" === Object.prototype.toString.call(e2);
          }
          var n = { load: function() {
            throw new Error("This method has been removed in JSZip 3.0, please check the upgrade guide.");
          }, forEach: function(e2) {
            var t2, r2, n2;
            for (t2 in this.files) n2 = this.files[t2], (r2 = t2.slice(this.root.length, t2.length)) && t2.slice(0, this.root.length) === this.root && e2(r2, n2);
          }, filter: function(r2) {
            var n2 = [];
            return this.forEach(function(e2, t2) {
              r2(e2, t2) && n2.push(t2);
            }), n2;
          }, file: function(e2, t2, r2) {
            if (1 !== arguments.length) return e2 = this.root + e2, s.call(this, e2, t2, r2), this;
            if (h(e2)) {
              var n2 = e2;
              return this.filter(function(e3, t3) {
                return !t3.dir && n2.test(e3);
              });
            }
            var i2 = this.files[this.root + e2];
            return i2 && !i2.dir ? i2 : null;
          }, folder: function(r2) {
            if (!r2) return this;
            if (h(r2)) return this.filter(function(e3, t3) {
              return t3.dir && r2.test(e3);
            });
            var e2 = this.root + r2, t2 = b.call(this, e2), n2 = this.clone();
            return n2.root = t2.name, n2;
          }, remove: function(r2) {
            r2 = this.root + r2;
            var e2 = this.files[r2];
            if (e2 || ("/" !== r2.slice(-1) && (r2 += "/"), e2 = this.files[r2]), e2 && !e2.dir) delete this.files[r2];
            else for (var t2 = this.filter(function(e3, t3) {
              return t3.name.slice(0, r2.length) === r2;
            }), n2 = 0; n2 < t2.length; n2++) delete this.files[t2[n2].name];
            return this;
          }, generate: function() {
            throw new Error("This method has been removed in JSZip 3.0, please check the upgrade guide.");
          }, generateInternalStream: function(e2) {
            var t2, r2 = {};
            try {
              if ((r2 = u.extend(e2 || {}, { streamFiles: false, compression: "STORE", compressionOptions: null, type: "", platform: "DOS", comment: null, mimeType: "application/zip", encodeFileName: i.utf8encode })).type = r2.type.toLowerCase(), r2.compression = r2.compression.toUpperCase(), "binarystring" === r2.type && (r2.type = "string"), !r2.type) throw new Error("No output type specified.");
              u.checkSupport(r2.type), "darwin" !== r2.platform && "freebsd" !== r2.platform && "linux" !== r2.platform && "sunos" !== r2.platform || (r2.platform = "UNIX"), "win32" === r2.platform && (r2.platform = "DOS");
              var n2 = r2.comment || this.comment || "";
              t2 = o.generateWorker(this, r2, n2);
            } catch (e3) {
              (t2 = new l("error")).error(e3);
            }
            return new a(t2, r2.type || "string", r2.mimeType);
          }, generateAsync: function(e2, t2) {
            return this.generateInternalStream(e2).accumulate(t2);
          }, generateNodeStream: function(e2, t2) {
            return (e2 = e2 || {}).type || (e2.type = "nodebuffer"), this.generateInternalStream(e2).toNodejsStream(t2);
          } };
          t.exports = n;
        }, { "./compressedObject": 2, "./defaults": 5, "./generate": 9, "./nodejs/NodejsStreamInputAdapter": 12, "./nodejsUtils": 14, "./stream/GenericWorker": 28, "./stream/StreamHelper": 29, "./utf8": 31, "./utils": 32, "./zipObject": 35 }], 16: [function(e, t, r) {
          "use strict";
          t.exports = e("stream");
        }, { stream: void 0 }], 17: [function(e, t, r) {
          "use strict";
          var n = e("./DataReader");
          function i(e2) {
            n.call(this, e2);
            for (var t2 = 0; t2 < this.data.length; t2++) e2[t2] = 255 & e2[t2];
          }
          e("../utils").inherits(i, n), i.prototype.byteAt = function(e2) {
            return this.data[this.zero + e2];
          }, i.prototype.lastIndexOfSignature = function(e2) {
            for (var t2 = e2.charCodeAt(0), r2 = e2.charCodeAt(1), n2 = e2.charCodeAt(2), i2 = e2.charCodeAt(3), s = this.length - 4; 0 <= s; --s) if (this.data[s] === t2 && this.data[s + 1] === r2 && this.data[s + 2] === n2 && this.data[s + 3] === i2) return s - this.zero;
            return -1;
          }, i.prototype.readAndCheckSignature = function(e2) {
            var t2 = e2.charCodeAt(0), r2 = e2.charCodeAt(1), n2 = e2.charCodeAt(2), i2 = e2.charCodeAt(3), s = this.readData(4);
            return t2 === s[0] && r2 === s[1] && n2 === s[2] && i2 === s[3];
          }, i.prototype.readData = function(e2) {
            if (this.checkOffset(e2), 0 === e2) return [];
            var t2 = this.data.slice(this.zero + this.index, this.zero + this.index + e2);
            return this.index += e2, t2;
          }, t.exports = i;
        }, { "../utils": 32, "./DataReader": 18 }], 18: [function(e, t, r) {
          "use strict";
          var n = e("../utils");
          function i(e2) {
            this.data = e2, this.length = e2.length, this.index = 0, this.zero = 0;
          }
          i.prototype = { checkOffset: function(e2) {
            this.checkIndex(this.index + e2);
          }, checkIndex: function(e2) {
            if (this.length < this.zero + e2 || e2 < 0) throw new Error("End of data reached (data length = " + this.length + ", asked index = " + e2 + "). Corrupted zip ?");
          }, setIndex: function(e2) {
            this.checkIndex(e2), this.index = e2;
          }, skip: function(e2) {
            this.setIndex(this.index + e2);
          }, byteAt: function() {
          }, readInt: function(e2) {
            var t2, r2 = 0;
            for (this.checkOffset(e2), t2 = this.index + e2 - 1; t2 >= this.index; t2--) r2 = (r2 << 8) + this.byteAt(t2);
            return this.index += e2, r2;
          }, readString: function(e2) {
            return n.transformTo("string", this.readData(e2));
          }, readData: function() {
          }, lastIndexOfSignature: function() {
          }, readAndCheckSignature: function() {
          }, readDate: function() {
            var e2 = this.readInt(4);
            return new Date(Date.UTC(1980 + (e2 >> 25 & 127), (e2 >> 21 & 15) - 1, e2 >> 16 & 31, e2 >> 11 & 31, e2 >> 5 & 63, (31 & e2) << 1));
          } }, t.exports = i;
        }, { "../utils": 32 }], 19: [function(e, t, r) {
          "use strict";
          var n = e("./Uint8ArrayReader");
          function i(e2) {
            n.call(this, e2);
          }
          e("../utils").inherits(i, n), i.prototype.readData = function(e2) {
            this.checkOffset(e2);
            var t2 = this.data.slice(this.zero + this.index, this.zero + this.index + e2);
            return this.index += e2, t2;
          }, t.exports = i;
        }, { "../utils": 32, "./Uint8ArrayReader": 21 }], 20: [function(e, t, r) {
          "use strict";
          var n = e("./DataReader");
          function i(e2) {
            n.call(this, e2);
          }
          e("../utils").inherits(i, n), i.prototype.byteAt = function(e2) {
            return this.data.charCodeAt(this.zero + e2);
          }, i.prototype.lastIndexOfSignature = function(e2) {
            return this.data.lastIndexOf(e2) - this.zero;
          }, i.prototype.readAndCheckSignature = function(e2) {
            return e2 === this.readData(4);
          }, i.prototype.readData = function(e2) {
            this.checkOffset(e2);
            var t2 = this.data.slice(this.zero + this.index, this.zero + this.index + e2);
            return this.index += e2, t2;
          }, t.exports = i;
        }, { "../utils": 32, "./DataReader": 18 }], 21: [function(e, t, r) {
          "use strict";
          var n = e("./ArrayReader");
          function i(e2) {
            n.call(this, e2);
          }
          e("../utils").inherits(i, n), i.prototype.readData = function(e2) {
            if (this.checkOffset(e2), 0 === e2) return new Uint8Array(0);
            var t2 = this.data.subarray(this.zero + this.index, this.zero + this.index + e2);
            return this.index += e2, t2;
          }, t.exports = i;
        }, { "../utils": 32, "./ArrayReader": 17 }], 22: [function(e, t, r) {
          "use strict";
          var n = e("../utils"), i = e("../support"), s = e("./ArrayReader"), a = e("./StringReader"), o = e("./NodeBufferReader"), h = e("./Uint8ArrayReader");
          t.exports = function(e2) {
            var t2 = n.getTypeOf(e2);
            return n.checkSupport(t2), "string" !== t2 || i.uint8array ? "nodebuffer" === t2 ? new o(e2) : i.uint8array ? new h(n.transformTo("uint8array", e2)) : new s(n.transformTo("array", e2)) : new a(e2);
          };
        }, { "../support": 30, "../utils": 32, "./ArrayReader": 17, "./NodeBufferReader": 19, "./StringReader": 20, "./Uint8ArrayReader": 21 }], 23: [function(e, t, r) {
          "use strict";
          r.LOCAL_FILE_HEADER = "PK", r.CENTRAL_FILE_HEADER = "PK", r.CENTRAL_DIRECTORY_END = "PK", r.ZIP64_CENTRAL_DIRECTORY_LOCATOR = "PK\x07", r.ZIP64_CENTRAL_DIRECTORY_END = "PK", r.DATA_DESCRIPTOR = "PK\x07\b";
        }, {}], 24: [function(e, t, r) {
          "use strict";
          var n = e("./GenericWorker"), i = e("../utils");
          function s(e2) {
            n.call(this, "ConvertWorker to " + e2), this.destType = e2;
          }
          i.inherits(s, n), s.prototype.processChunk = function(e2) {
            this.push({ data: i.transformTo(this.destType, e2.data), meta: e2.meta });
          }, t.exports = s;
        }, { "../utils": 32, "./GenericWorker": 28 }], 25: [function(e, t, r) {
          "use strict";
          var n = e("./GenericWorker"), i = e("../crc32");
          function s() {
            n.call(this, "Crc32Probe"), this.withStreamInfo("crc32", 0);
          }
          e("../utils").inherits(s, n), s.prototype.processChunk = function(e2) {
            this.streamInfo.crc32 = i(e2.data, this.streamInfo.crc32 || 0), this.push(e2);
          }, t.exports = s;
        }, { "../crc32": 4, "../utils": 32, "./GenericWorker": 28 }], 26: [function(e, t, r) {
          "use strict";
          var n = e("../utils"), i = e("./GenericWorker");
          function s(e2) {
            i.call(this, "DataLengthProbe for " + e2), this.propName = e2, this.withStreamInfo(e2, 0);
          }
          n.inherits(s, i), s.prototype.processChunk = function(e2) {
            if (e2) {
              var t2 = this.streamInfo[this.propName] || 0;
              this.streamInfo[this.propName] = t2 + e2.data.length;
            }
            i.prototype.processChunk.call(this, e2);
          }, t.exports = s;
        }, { "../utils": 32, "./GenericWorker": 28 }], 27: [function(e, t, r) {
          "use strict";
          var n = e("../utils"), i = e("./GenericWorker");
          function s(e2) {
            i.call(this, "DataWorker");
            var t2 = this;
            this.dataIsReady = false, this.index = 0, this.max = 0, this.data = null, this.type = "", this._tickScheduled = false, e2.then(function(e3) {
              t2.dataIsReady = true, t2.data = e3, t2.max = e3 && e3.length || 0, t2.type = n.getTypeOf(e3), t2.isPaused || t2._tickAndRepeat();
            }, function(e3) {
              t2.error(e3);
            });
          }
          n.inherits(s, i), s.prototype.cleanUp = function() {
            i.prototype.cleanUp.call(this), this.data = null;
          }, s.prototype.resume = function() {
            return !!i.prototype.resume.call(this) && (!this._tickScheduled && this.dataIsReady && (this._tickScheduled = true, n.delay(this._tickAndRepeat, [], this)), true);
          }, s.prototype._tickAndRepeat = function() {
            this._tickScheduled = false, this.isPaused || this.isFinished || (this._tick(), this.isFinished || (n.delay(this._tickAndRepeat, [], this), this._tickScheduled = true));
          }, s.prototype._tick = function() {
            if (this.isPaused || this.isFinished) return false;
            var e2 = null, t2 = Math.min(this.max, this.index + 16384);
            if (this.index >= this.max) return this.end();
            switch (this.type) {
              case "string":
                e2 = this.data.substring(this.index, t2);
                break;
              case "uint8array":
                e2 = this.data.subarray(this.index, t2);
                break;
              case "array":
              case "nodebuffer":
                e2 = this.data.slice(this.index, t2);
            }
            return this.index = t2, this.push({ data: e2, meta: { percent: this.max ? this.index / this.max * 100 : 0 } });
          }, t.exports = s;
        }, { "../utils": 32, "./GenericWorker": 28 }], 28: [function(e, t, r) {
          "use strict";
          function n(e2) {
            this.name = e2 || "default", this.streamInfo = {}, this.generatedError = null, this.extraStreamInfo = {}, this.isPaused = true, this.isFinished = false, this.isLocked = false, this._listeners = { data: [], end: [], error: [] }, this.previous = null;
          }
          n.prototype = { push: function(e2) {
            this.emit("data", e2);
          }, end: function() {
            if (this.isFinished) return false;
            this.flush();
            try {
              this.emit("end"), this.cleanUp(), this.isFinished = true;
            } catch (e2) {
              this.emit("error", e2);
            }
            return true;
          }, error: function(e2) {
            return !this.isFinished && (this.isPaused ? this.generatedError = e2 : (this.isFinished = true, this.emit("error", e2), this.previous && this.previous.error(e2), this.cleanUp()), true);
          }, on: function(e2, t2) {
            return this._listeners[e2].push(t2), this;
          }, cleanUp: function() {
            this.streamInfo = this.generatedError = this.extraStreamInfo = null, this._listeners = [];
          }, emit: function(e2, t2) {
            if (this._listeners[e2]) for (var r2 = 0; r2 < this._listeners[e2].length; r2++) this._listeners[e2][r2].call(this, t2);
          }, pipe: function(e2) {
            return e2.registerPrevious(this);
          }, registerPrevious: function(e2) {
            if (this.isLocked) throw new Error("The stream '" + this + "' has already been used.");
            this.streamInfo = e2.streamInfo, this.mergeStreamInfo(), this.previous = e2;
            var t2 = this;
            return e2.on("data", function(e3) {
              t2.processChunk(e3);
            }), e2.on("end", function() {
              t2.end();
            }), e2.on("error", function(e3) {
              t2.error(e3);
            }), this;
          }, pause: function() {
            return !this.isPaused && !this.isFinished && (this.isPaused = true, this.previous && this.previous.pause(), true);
          }, resume: function() {
            if (!this.isPaused || this.isFinished) return false;
            var e2 = this.isPaused = false;
            return this.generatedError && (this.error(this.generatedError), e2 = true), this.previous && this.previous.resume(), !e2;
          }, flush: function() {
          }, processChunk: function(e2) {
            this.push(e2);
          }, withStreamInfo: function(e2, t2) {
            return this.extraStreamInfo[e2] = t2, this.mergeStreamInfo(), this;
          }, mergeStreamInfo: function() {
            for (var e2 in this.extraStreamInfo) Object.prototype.hasOwnProperty.call(this.extraStreamInfo, e2) && (this.streamInfo[e2] = this.extraStreamInfo[e2]);
          }, lock: function() {
            if (this.isLocked) throw new Error("The stream '" + this + "' has already been used.");
            this.isLocked = true, this.previous && this.previous.lock();
          }, toString: function() {
            var e2 = "Worker " + this.name;
            return this.previous ? this.previous + " -> " + e2 : e2;
          } }, t.exports = n;
        }, {}], 29: [function(e, t, r) {
          "use strict";
          var h = e("../utils"), i = e("./ConvertWorker"), s = e("./GenericWorker"), u = e("../base64"), n = e("../support"), a = e("../external"), o = null;
          if (n.nodestream) try {
            o = e("../nodejs/NodejsStreamOutputAdapter");
          } catch (e2) {
          }
          function l(e2, o2) {
            return new a.Promise(function(t2, r2) {
              var n2 = [], i2 = e2._internalType, s2 = e2._outputType, a2 = e2._mimeType;
              e2.on("data", function(e3, t3) {
                n2.push(e3), o2 && o2(t3);
              }).on("error", function(e3) {
                n2 = [], r2(e3);
              }).on("end", function() {
                try {
                  var e3 = (function(e4, t3, r3) {
                    switch (e4) {
                      case "blob":
                        return h.newBlob(h.transformTo("arraybuffer", t3), r3);
                      case "base64":
                        return u.encode(t3);
                      default:
                        return h.transformTo(e4, t3);
                    }
                  })(s2, (function(e4, t3) {
                    var r3, n3 = 0, i3 = null, s3 = 0;
                    for (r3 = 0; r3 < t3.length; r3++) s3 += t3[r3].length;
                    switch (e4) {
                      case "string":
                        return t3.join("");
                      case "array":
                        return Array.prototype.concat.apply([], t3);
                      case "uint8array":
                        for (i3 = new Uint8Array(s3), r3 = 0; r3 < t3.length; r3++) i3.set(t3[r3], n3), n3 += t3[r3].length;
                        return i3;
                      case "nodebuffer":
                        return Buffer.concat(t3);
                      default:
                        throw new Error("concat : unsupported type '" + e4 + "'");
                    }
                  })(i2, n2), a2);
                  t2(e3);
                } catch (e4) {
                  r2(e4);
                }
                n2 = [];
              }).resume();
            });
          }
          function f(e2, t2, r2) {
            var n2 = t2;
            switch (t2) {
              case "blob":
              case "arraybuffer":
                n2 = "uint8array";
                break;
              case "base64":
                n2 = "string";
            }
            try {
              this._internalType = n2, this._outputType = t2, this._mimeType = r2, h.checkSupport(n2), this._worker = e2.pipe(new i(n2)), e2.lock();
            } catch (e3) {
              this._worker = new s("error"), this._worker.error(e3);
            }
          }
          f.prototype = { accumulate: function(e2) {
            return l(this, e2);
          }, on: function(e2, t2) {
            var r2 = this;
            return "data" === e2 ? this._worker.on(e2, function(e3) {
              t2.call(r2, e3.data, e3.meta);
            }) : this._worker.on(e2, function() {
              h.delay(t2, arguments, r2);
            }), this;
          }, resume: function() {
            return h.delay(this._worker.resume, [], this._worker), this;
          }, pause: function() {
            return this._worker.pause(), this;
          }, toNodejsStream: function(e2) {
            if (h.checkSupport("nodestream"), "nodebuffer" !== this._outputType) throw new Error(this._outputType + " is not supported by this method");
            return new o(this, { objectMode: "nodebuffer" !== this._outputType }, e2);
          } }, t.exports = f;
        }, { "../base64": 1, "../external": 6, "../nodejs/NodejsStreamOutputAdapter": 13, "../support": 30, "../utils": 32, "./ConvertWorker": 24, "./GenericWorker": 28 }], 30: [function(e, t, r) {
          "use strict";
          if (r.base64 = true, r.array = true, r.string = true, r.arraybuffer = "undefined" != typeof ArrayBuffer && "undefined" != typeof Uint8Array, r.nodebuffer = "undefined" != typeof Buffer, r.uint8array = "undefined" != typeof Uint8Array, "undefined" == typeof ArrayBuffer) r.blob = false;
          else {
            var n = new ArrayBuffer(0);
            try {
              r.blob = 0 === new Blob([n], { type: "application/zip" }).size;
            } catch (e2) {
              try {
                var i = new (self.BlobBuilder || self.WebKitBlobBuilder || self.MozBlobBuilder || self.MSBlobBuilder)();
                i.append(n), r.blob = 0 === i.getBlob("application/zip").size;
              } catch (e3) {
                r.blob = false;
              }
            }
          }
          try {
            r.nodestream = !!e("readable-stream").Readable;
          } catch (e2) {
            r.nodestream = false;
          }
        }, { "readable-stream": 16 }], 31: [function(e, t, s) {
          "use strict";
          for (var o = e("./utils"), h = e("./support"), r = e("./nodejsUtils"), n = e("./stream/GenericWorker"), u = new Array(256), i = 0; i < 256; i++) u[i] = 252 <= i ? 6 : 248 <= i ? 5 : 240 <= i ? 4 : 224 <= i ? 3 : 192 <= i ? 2 : 1;
          u[254] = u[254] = 1;
          function a() {
            n.call(this, "utf-8 decode"), this.leftOver = null;
          }
          function l() {
            n.call(this, "utf-8 encode");
          }
          s.utf8encode = function(e2) {
            return h.nodebuffer ? r.newBufferFrom(e2, "utf-8") : (function(e3) {
              var t2, r2, n2, i2, s2, a2 = e3.length, o2 = 0;
              for (i2 = 0; i2 < a2; i2++) 55296 == (64512 & (r2 = e3.charCodeAt(i2))) && i2 + 1 < a2 && 56320 == (64512 & (n2 = e3.charCodeAt(i2 + 1))) && (r2 = 65536 + (r2 - 55296 << 10) + (n2 - 56320), i2++), o2 += r2 < 128 ? 1 : r2 < 2048 ? 2 : r2 < 65536 ? 3 : 4;
              for (t2 = h.uint8array ? new Uint8Array(o2) : new Array(o2), i2 = s2 = 0; s2 < o2; i2++) 55296 == (64512 & (r2 = e3.charCodeAt(i2))) && i2 + 1 < a2 && 56320 == (64512 & (n2 = e3.charCodeAt(i2 + 1))) && (r2 = 65536 + (r2 - 55296 << 10) + (n2 - 56320), i2++), r2 < 128 ? t2[s2++] = r2 : (r2 < 2048 ? t2[s2++] = 192 | r2 >>> 6 : (r2 < 65536 ? t2[s2++] = 224 | r2 >>> 12 : (t2[s2++] = 240 | r2 >>> 18, t2[s2++] = 128 | r2 >>> 12 & 63), t2[s2++] = 128 | r2 >>> 6 & 63), t2[s2++] = 128 | 63 & r2);
              return t2;
            })(e2);
          }, s.utf8decode = function(e2) {
            return h.nodebuffer ? o.transformTo("nodebuffer", e2).toString("utf-8") : (function(e3) {
              var t2, r2, n2, i2, s2 = e3.length, a2 = new Array(2 * s2);
              for (t2 = r2 = 0; t2 < s2; ) if ((n2 = e3[t2++]) < 128) a2[r2++] = n2;
              else if (4 < (i2 = u[n2])) a2[r2++] = 65533, t2 += i2 - 1;
              else {
                for (n2 &= 2 === i2 ? 31 : 3 === i2 ? 15 : 7; 1 < i2 && t2 < s2; ) n2 = n2 << 6 | 63 & e3[t2++], i2--;
                1 < i2 ? a2[r2++] = 65533 : n2 < 65536 ? a2[r2++] = n2 : (n2 -= 65536, a2[r2++] = 55296 | n2 >> 10 & 1023, a2[r2++] = 56320 | 1023 & n2);
              }
              return a2.length !== r2 && (a2.subarray ? a2 = a2.subarray(0, r2) : a2.length = r2), o.applyFromCharCode(a2);
            })(e2 = o.transformTo(h.uint8array ? "uint8array" : "array", e2));
          }, o.inherits(a, n), a.prototype.processChunk = function(e2) {
            var t2 = o.transformTo(h.uint8array ? "uint8array" : "array", e2.data);
            if (this.leftOver && this.leftOver.length) {
              if (h.uint8array) {
                var r2 = t2;
                (t2 = new Uint8Array(r2.length + this.leftOver.length)).set(this.leftOver, 0), t2.set(r2, this.leftOver.length);
              } else t2 = this.leftOver.concat(t2);
              this.leftOver = null;
            }
            var n2 = (function(e3, t3) {
              var r3;
              for ((t3 = t3 || e3.length) > e3.length && (t3 = e3.length), r3 = t3 - 1; 0 <= r3 && 128 == (192 & e3[r3]); ) r3--;
              return r3 < 0 ? t3 : 0 === r3 ? t3 : r3 + u[e3[r3]] > t3 ? r3 : t3;
            })(t2), i2 = t2;
            n2 !== t2.length && (h.uint8array ? (i2 = t2.subarray(0, n2), this.leftOver = t2.subarray(n2, t2.length)) : (i2 = t2.slice(0, n2), this.leftOver = t2.slice(n2, t2.length))), this.push({ data: s.utf8decode(i2), meta: e2.meta });
          }, a.prototype.flush = function() {
            this.leftOver && this.leftOver.length && (this.push({ data: s.utf8decode(this.leftOver), meta: {} }), this.leftOver = null);
          }, s.Utf8DecodeWorker = a, o.inherits(l, n), l.prototype.processChunk = function(e2) {
            this.push({ data: s.utf8encode(e2.data), meta: e2.meta });
          }, s.Utf8EncodeWorker = l;
        }, { "./nodejsUtils": 14, "./stream/GenericWorker": 28, "./support": 30, "./utils": 32 }], 32: [function(e, t, a) {
          "use strict";
          var o = e("./support"), h = e("./base64"), r = e("./nodejsUtils"), u = e("./external");
          function n(e2) {
            return e2;
          }
          function l(e2, t2) {
            for (var r2 = 0; r2 < e2.length; ++r2) t2[r2] = 255 & e2.charCodeAt(r2);
            return t2;
          }
          e("setimmediate"), a.newBlob = function(t2, r2) {
            a.checkSupport("blob");
            try {
              return new Blob([t2], { type: r2 });
            } catch (e2) {
              try {
                var n2 = new (self.BlobBuilder || self.WebKitBlobBuilder || self.MozBlobBuilder || self.MSBlobBuilder)();
                return n2.append(t2), n2.getBlob(r2);
              } catch (e3) {
                throw new Error("Bug : can't construct the Blob.");
              }
            }
          };
          var i = { stringifyByChunk: function(e2, t2, r2) {
            var n2 = [], i2 = 0, s2 = e2.length;
            if (s2 <= r2) return String.fromCharCode.apply(null, e2);
            for (; i2 < s2; ) "array" === t2 || "nodebuffer" === t2 ? n2.push(String.fromCharCode.apply(null, e2.slice(i2, Math.min(i2 + r2, s2)))) : n2.push(String.fromCharCode.apply(null, e2.subarray(i2, Math.min(i2 + r2, s2)))), i2 += r2;
            return n2.join("");
          }, stringifyByChar: function(e2) {
            for (var t2 = "", r2 = 0; r2 < e2.length; r2++) t2 += String.fromCharCode(e2[r2]);
            return t2;
          }, applyCanBeUsed: { uint8array: (function() {
            try {
              return o.uint8array && 1 === String.fromCharCode.apply(null, new Uint8Array(1)).length;
            } catch (e2) {
              return false;
            }
          })(), nodebuffer: (function() {
            try {
              return o.nodebuffer && 1 === String.fromCharCode.apply(null, r.allocBuffer(1)).length;
            } catch (e2) {
              return false;
            }
          })() } };
          function s(e2) {
            var t2 = 65536, r2 = a.getTypeOf(e2), n2 = true;
            if ("uint8array" === r2 ? n2 = i.applyCanBeUsed.uint8array : "nodebuffer" === r2 && (n2 = i.applyCanBeUsed.nodebuffer), n2) for (; 1 < t2; ) try {
              return i.stringifyByChunk(e2, r2, t2);
            } catch (e3) {
              t2 = Math.floor(t2 / 2);
            }
            return i.stringifyByChar(e2);
          }
          function f(e2, t2) {
            for (var r2 = 0; r2 < e2.length; r2++) t2[r2] = e2[r2];
            return t2;
          }
          a.applyFromCharCode = s;
          var c = {};
          c.string = { string: n, array: function(e2) {
            return l(e2, new Array(e2.length));
          }, arraybuffer: function(e2) {
            return c.string.uint8array(e2).buffer;
          }, uint8array: function(e2) {
            return l(e2, new Uint8Array(e2.length));
          }, nodebuffer: function(e2) {
            return l(e2, r.allocBuffer(e2.length));
          } }, c.array = { string: s, array: n, arraybuffer: function(e2) {
            return new Uint8Array(e2).buffer;
          }, uint8array: function(e2) {
            return new Uint8Array(e2);
          }, nodebuffer: function(e2) {
            return r.newBufferFrom(e2);
          } }, c.arraybuffer = { string: function(e2) {
            return s(new Uint8Array(e2));
          }, array: function(e2) {
            return f(new Uint8Array(e2), new Array(e2.byteLength));
          }, arraybuffer: n, uint8array: function(e2) {
            return new Uint8Array(e2);
          }, nodebuffer: function(e2) {
            return r.newBufferFrom(new Uint8Array(e2));
          } }, c.uint8array = { string: s, array: function(e2) {
            return f(e2, new Array(e2.length));
          }, arraybuffer: function(e2) {
            return e2.buffer;
          }, uint8array: n, nodebuffer: function(e2) {
            return r.newBufferFrom(e2);
          } }, c.nodebuffer = { string: s, array: function(e2) {
            return f(e2, new Array(e2.length));
          }, arraybuffer: function(e2) {
            return c.nodebuffer.uint8array(e2).buffer;
          }, uint8array: function(e2) {
            return f(e2, new Uint8Array(e2.length));
          }, nodebuffer: n }, a.transformTo = function(e2, t2) {
            if (t2 = t2 || "", !e2) return t2;
            a.checkSupport(e2);
            var r2 = a.getTypeOf(t2);
            return c[r2][e2](t2);
          }, a.resolve = function(e2) {
            for (var t2 = e2.split("/"), r2 = [], n2 = 0; n2 < t2.length; n2++) {
              var i2 = t2[n2];
              "." === i2 || "" === i2 && 0 !== n2 && n2 !== t2.length - 1 || (".." === i2 ? r2.pop() : r2.push(i2));
            }
            return r2.join("/");
          }, a.getTypeOf = function(e2) {
            return "string" == typeof e2 ? "string" : "[object Array]" === Object.prototype.toString.call(e2) ? "array" : o.nodebuffer && r.isBuffer(e2) ? "nodebuffer" : o.uint8array && e2 instanceof Uint8Array ? "uint8array" : o.arraybuffer && e2 instanceof ArrayBuffer ? "arraybuffer" : void 0;
          }, a.checkSupport = function(e2) {
            if (!o[e2.toLowerCase()]) throw new Error(e2 + " is not supported by this platform");
          }, a.MAX_VALUE_16BITS = 65535, a.MAX_VALUE_32BITS = -1, a.pretty = function(e2) {
            var t2, r2, n2 = "";
            for (r2 = 0; r2 < (e2 || "").length; r2++) n2 += "\\x" + ((t2 = e2.charCodeAt(r2)) < 16 ? "0" : "") + t2.toString(16).toUpperCase();
            return n2;
          }, a.delay = function(e2, t2, r2) {
            setImmediate(function() {
              e2.apply(r2 || null, t2 || []);
            });
          }, a.inherits = function(e2, t2) {
            function r2() {
            }
            r2.prototype = t2.prototype, e2.prototype = new r2();
          }, a.extend = function() {
            var e2, t2, r2 = {};
            for (e2 = 0; e2 < arguments.length; e2++) for (t2 in arguments[e2]) Object.prototype.hasOwnProperty.call(arguments[e2], t2) && void 0 === r2[t2] && (r2[t2] = arguments[e2][t2]);
            return r2;
          }, a.prepareContent = function(r2, e2, n2, i2, s2) {
            return u.Promise.resolve(e2).then(function(n3) {
              return o.blob && (n3 instanceof Blob || -1 !== ["[object File]", "[object Blob]"].indexOf(Object.prototype.toString.call(n3))) && "undefined" != typeof FileReader ? new u.Promise(function(t2, r3) {
                var e3 = new FileReader();
                e3.onload = function(e4) {
                  t2(e4.target.result);
                }, e3.onerror = function(e4) {
                  r3(e4.target.error);
                }, e3.readAsArrayBuffer(n3);
              }) : n3;
            }).then(function(e3) {
              var t2 = a.getTypeOf(e3);
              return t2 ? ("arraybuffer" === t2 ? e3 = a.transformTo("uint8array", e3) : "string" === t2 && (s2 ? e3 = h.decode(e3) : n2 && true !== i2 && (e3 = (function(e4) {
                return l(e4, o.uint8array ? new Uint8Array(e4.length) : new Array(e4.length));
              })(e3))), e3) : u.Promise.reject(new Error("Can't read the data of '" + r2 + "'. Is it in a supported JavaScript type (String, Blob, ArrayBuffer, etc) ?"));
            });
          };
        }, { "./base64": 1, "./external": 6, "./nodejsUtils": 14, "./support": 30, setimmediate: 54 }], 33: [function(e, t, r) {
          "use strict";
          var n = e("./reader/readerFor"), i = e("./utils"), s = e("./signature"), a = e("./zipEntry"), o = e("./support");
          function h(e2) {
            this.files = [], this.loadOptions = e2;
          }
          h.prototype = { checkSignature: function(e2) {
            if (!this.reader.readAndCheckSignature(e2)) {
              this.reader.index -= 4;
              var t2 = this.reader.readString(4);
              throw new Error("Corrupted zip or bug: unexpected signature (" + i.pretty(t2) + ", expected " + i.pretty(e2) + ")");
            }
          }, isSignature: function(e2, t2) {
            var r2 = this.reader.index;
            this.reader.setIndex(e2);
            var n2 = this.reader.readString(4) === t2;
            return this.reader.setIndex(r2), n2;
          }, readBlockEndOfCentral: function() {
            this.diskNumber = this.reader.readInt(2), this.diskWithCentralDirStart = this.reader.readInt(2), this.centralDirRecordsOnThisDisk = this.reader.readInt(2), this.centralDirRecords = this.reader.readInt(2), this.centralDirSize = this.reader.readInt(4), this.centralDirOffset = this.reader.readInt(4), this.zipCommentLength = this.reader.readInt(2);
            var e2 = this.reader.readData(this.zipCommentLength), t2 = o.uint8array ? "uint8array" : "array", r2 = i.transformTo(t2, e2);
            this.zipComment = this.loadOptions.decodeFileName(r2);
          }, readBlockZip64EndOfCentral: function() {
            this.zip64EndOfCentralSize = this.reader.readInt(8), this.reader.skip(4), this.diskNumber = this.reader.readInt(4), this.diskWithCentralDirStart = this.reader.readInt(4), this.centralDirRecordsOnThisDisk = this.reader.readInt(8), this.centralDirRecords = this.reader.readInt(8), this.centralDirSize = this.reader.readInt(8), this.centralDirOffset = this.reader.readInt(8), this.zip64ExtensibleData = {};
            for (var e2, t2, r2, n2 = this.zip64EndOfCentralSize - 44; 0 < n2; ) e2 = this.reader.readInt(2), t2 = this.reader.readInt(4), r2 = this.reader.readData(t2), this.zip64ExtensibleData[e2] = { id: e2, length: t2, value: r2 };
          }, readBlockZip64EndOfCentralLocator: function() {
            if (this.diskWithZip64CentralDirStart = this.reader.readInt(4), this.relativeOffsetEndOfZip64CentralDir = this.reader.readInt(8), this.disksCount = this.reader.readInt(4), 1 < this.disksCount) throw new Error("Multi-volumes zip are not supported");
          }, readLocalFiles: function() {
            var e2, t2;
            for (e2 = 0; e2 < this.files.length; e2++) t2 = this.files[e2], this.reader.setIndex(t2.localHeaderOffset), this.checkSignature(s.LOCAL_FILE_HEADER), t2.readLocalPart(this.reader), t2.handleUTF8(), t2.processAttributes();
          }, readCentralDir: function() {
            var e2;
            for (this.reader.setIndex(this.centralDirOffset); this.reader.readAndCheckSignature(s.CENTRAL_FILE_HEADER); ) (e2 = new a({ zip64: this.zip64 }, this.loadOptions)).readCentralPart(this.reader), this.files.push(e2);
            if (this.centralDirRecords !== this.files.length && 0 !== this.centralDirRecords && 0 === this.files.length) throw new Error("Corrupted zip or bug: expected " + this.centralDirRecords + " records in central dir, got " + this.files.length);
          }, readEndOfCentral: function() {
            var e2 = this.reader.lastIndexOfSignature(s.CENTRAL_DIRECTORY_END);
            if (e2 < 0) throw !this.isSignature(0, s.LOCAL_FILE_HEADER) ? new Error("Can't find end of central directory : is this a zip file ? If it is, see https://stuk.github.io/jszip/documentation/howto/read_zip.html") : new Error("Corrupted zip: can't find end of central directory");
            this.reader.setIndex(e2);
            var t2 = e2;
            if (this.checkSignature(s.CENTRAL_DIRECTORY_END), this.readBlockEndOfCentral(), this.diskNumber === i.MAX_VALUE_16BITS || this.diskWithCentralDirStart === i.MAX_VALUE_16BITS || this.centralDirRecordsOnThisDisk === i.MAX_VALUE_16BITS || this.centralDirRecords === i.MAX_VALUE_16BITS || this.centralDirSize === i.MAX_VALUE_32BITS || this.centralDirOffset === i.MAX_VALUE_32BITS) {
              if (this.zip64 = true, (e2 = this.reader.lastIndexOfSignature(s.ZIP64_CENTRAL_DIRECTORY_LOCATOR)) < 0) throw new Error("Corrupted zip: can't find the ZIP64 end of central directory locator");
              if (this.reader.setIndex(e2), this.checkSignature(s.ZIP64_CENTRAL_DIRECTORY_LOCATOR), this.readBlockZip64EndOfCentralLocator(), !this.isSignature(this.relativeOffsetEndOfZip64CentralDir, s.ZIP64_CENTRAL_DIRECTORY_END) && (this.relativeOffsetEndOfZip64CentralDir = this.reader.lastIndexOfSignature(s.ZIP64_CENTRAL_DIRECTORY_END), this.relativeOffsetEndOfZip64CentralDir < 0)) throw new Error("Corrupted zip: can't find the ZIP64 end of central directory");
              this.reader.setIndex(this.relativeOffsetEndOfZip64CentralDir), this.checkSignature(s.ZIP64_CENTRAL_DIRECTORY_END), this.readBlockZip64EndOfCentral();
            }
            var r2 = this.centralDirOffset + this.centralDirSize;
            this.zip64 && (r2 += 20, r2 += 12 + this.zip64EndOfCentralSize);
            var n2 = t2 - r2;
            if (0 < n2) this.isSignature(t2, s.CENTRAL_FILE_HEADER) || (this.reader.zero = n2);
            else if (n2 < 0) throw new Error("Corrupted zip: missing " + Math.abs(n2) + " bytes.");
          }, prepareReader: function(e2) {
            this.reader = n(e2);
          }, load: function(e2) {
            this.prepareReader(e2), this.readEndOfCentral(), this.readCentralDir(), this.readLocalFiles();
          } }, t.exports = h;
        }, { "./reader/readerFor": 22, "./signature": 23, "./support": 30, "./utils": 32, "./zipEntry": 34 }], 34: [function(e, t, r) {
          "use strict";
          var n = e("./reader/readerFor"), s = e("./utils"), i = e("./compressedObject"), a = e("./crc32"), o = e("./utf8"), h = e("./compressions"), u = e("./support");
          function l(e2, t2) {
            this.options = e2, this.loadOptions = t2;
          }
          l.prototype = { isEncrypted: function() {
            return 1 == (1 & this.bitFlag);
          }, useUTF8: function() {
            return 2048 == (2048 & this.bitFlag);
          }, readLocalPart: function(e2) {
            var t2, r2;
            if (e2.skip(22), this.fileNameLength = e2.readInt(2), r2 = e2.readInt(2), this.fileName = e2.readData(this.fileNameLength), e2.skip(r2), -1 === this.compressedSize || -1 === this.uncompressedSize) throw new Error("Bug or corrupted zip : didn't get enough information from the central directory (compressedSize === -1 || uncompressedSize === -1)");
            if (null === (t2 = (function(e3) {
              for (var t3 in h) if (Object.prototype.hasOwnProperty.call(h, t3) && h[t3].magic === e3) return h[t3];
              return null;
            })(this.compressionMethod))) throw new Error("Corrupted zip : compression " + s.pretty(this.compressionMethod) + " unknown (inner file : " + s.transformTo("string", this.fileName) + ")");
            this.decompressed = new i(this.compressedSize, this.uncompressedSize, this.crc32, t2, e2.readData(this.compressedSize));
          }, readCentralPart: function(e2) {
            this.versionMadeBy = e2.readInt(2), e2.skip(2), this.bitFlag = e2.readInt(2), this.compressionMethod = e2.readString(2), this.date = e2.readDate(), this.crc32 = e2.readInt(4), this.compressedSize = e2.readInt(4), this.uncompressedSize = e2.readInt(4);
            var t2 = e2.readInt(2);
            if (this.extraFieldsLength = e2.readInt(2), this.fileCommentLength = e2.readInt(2), this.diskNumberStart = e2.readInt(2), this.internalFileAttributes = e2.readInt(2), this.externalFileAttributes = e2.readInt(4), this.localHeaderOffset = e2.readInt(4), this.isEncrypted()) throw new Error("Encrypted zip are not supported");
            e2.skip(t2), this.readExtraFields(e2), this.parseZIP64ExtraField(e2), this.fileComment = e2.readData(this.fileCommentLength);
          }, processAttributes: function() {
            this.unixPermissions = null, this.dosPermissions = null;
            var e2 = this.versionMadeBy >> 8;
            this.dir = !!(16 & this.externalFileAttributes), 0 == e2 && (this.dosPermissions = 63 & this.externalFileAttributes), 3 == e2 && (this.unixPermissions = this.externalFileAttributes >> 16 & 65535), this.dir || "/" !== this.fileNameStr.slice(-1) || (this.dir = true);
          }, parseZIP64ExtraField: function() {
            if (this.extraFields[1]) {
              var e2 = n(this.extraFields[1].value);
              this.uncompressedSize === s.MAX_VALUE_32BITS && (this.uncompressedSize = e2.readInt(8)), this.compressedSize === s.MAX_VALUE_32BITS && (this.compressedSize = e2.readInt(8)), this.localHeaderOffset === s.MAX_VALUE_32BITS && (this.localHeaderOffset = e2.readInt(8)), this.diskNumberStart === s.MAX_VALUE_32BITS && (this.diskNumberStart = e2.readInt(4));
            }
          }, readExtraFields: function(e2) {
            var t2, r2, n2, i2 = e2.index + this.extraFieldsLength;
            for (this.extraFields || (this.extraFields = {}); e2.index + 4 < i2; ) t2 = e2.readInt(2), r2 = e2.readInt(2), n2 = e2.readData(r2), this.extraFields[t2] = { id: t2, length: r2, value: n2 };
            e2.setIndex(i2);
          }, handleUTF8: function() {
            var e2 = u.uint8array ? "uint8array" : "array";
            if (this.useUTF8()) this.fileNameStr = o.utf8decode(this.fileName), this.fileCommentStr = o.utf8decode(this.fileComment);
            else {
              var t2 = this.findExtraFieldUnicodePath();
              if (null !== t2) this.fileNameStr = t2;
              else {
                var r2 = s.transformTo(e2, this.fileName);
                this.fileNameStr = this.loadOptions.decodeFileName(r2);
              }
              var n2 = this.findExtraFieldUnicodeComment();
              if (null !== n2) this.fileCommentStr = n2;
              else {
                var i2 = s.transformTo(e2, this.fileComment);
                this.fileCommentStr = this.loadOptions.decodeFileName(i2);
              }
            }
          }, findExtraFieldUnicodePath: function() {
            var e2 = this.extraFields[28789];
            if (e2) {
              var t2 = n(e2.value);
              return 1 !== t2.readInt(1) ? null : a(this.fileName) !== t2.readInt(4) ? null : o.utf8decode(t2.readData(e2.length - 5));
            }
            return null;
          }, findExtraFieldUnicodeComment: function() {
            var e2 = this.extraFields[25461];
            if (e2) {
              var t2 = n(e2.value);
              return 1 !== t2.readInt(1) ? null : a(this.fileComment) !== t2.readInt(4) ? null : o.utf8decode(t2.readData(e2.length - 5));
            }
            return null;
          } }, t.exports = l;
        }, { "./compressedObject": 2, "./compressions": 3, "./crc32": 4, "./reader/readerFor": 22, "./support": 30, "./utf8": 31, "./utils": 32 }], 35: [function(e, t, r) {
          "use strict";
          function n(e2, t2, r2) {
            this.name = e2, this.dir = r2.dir, this.date = r2.date, this.comment = r2.comment, this.unixPermissions = r2.unixPermissions, this.dosPermissions = r2.dosPermissions, this._data = t2, this._dataBinary = r2.binary, this.options = { compression: r2.compression, compressionOptions: r2.compressionOptions };
          }
          var s = e("./stream/StreamHelper"), i = e("./stream/DataWorker"), a = e("./utf8"), o = e("./compressedObject"), h = e("./stream/GenericWorker");
          n.prototype = { internalStream: function(e2) {
            var t2 = null, r2 = "string";
            try {
              if (!e2) throw new Error("No output type specified.");
              var n2 = "string" === (r2 = e2.toLowerCase()) || "text" === r2;
              "binarystring" !== r2 && "text" !== r2 || (r2 = "string"), t2 = this._decompressWorker();
              var i2 = !this._dataBinary;
              i2 && !n2 && (t2 = t2.pipe(new a.Utf8EncodeWorker())), !i2 && n2 && (t2 = t2.pipe(new a.Utf8DecodeWorker()));
            } catch (e3) {
              (t2 = new h("error")).error(e3);
            }
            return new s(t2, r2, "");
          }, async: function(e2, t2) {
            return this.internalStream(e2).accumulate(t2);
          }, nodeStream: function(e2, t2) {
            return this.internalStream(e2 || "nodebuffer").toNodejsStream(t2);
          }, _compressWorker: function(e2, t2) {
            if (this._data instanceof o && this._data.compression.magic === e2.magic) return this._data.getCompressedWorker();
            var r2 = this._decompressWorker();
            return this._dataBinary || (r2 = r2.pipe(new a.Utf8EncodeWorker())), o.createWorkerFrom(r2, e2, t2);
          }, _decompressWorker: function() {
            return this._data instanceof o ? this._data.getContentWorker() : this._data instanceof h ? this._data : new i(this._data);
          } };
          for (var u = ["asText", "asBinary", "asNodeBuffer", "asUint8Array", "asArrayBuffer"], l = function() {
            throw new Error("This method has been removed in JSZip 3.0, please check the upgrade guide.");
          }, f = 0; f < u.length; f++) n.prototype[u[f]] = l;
          t.exports = n;
        }, { "./compressedObject": 2, "./stream/DataWorker": 27, "./stream/GenericWorker": 28, "./stream/StreamHelper": 29, "./utf8": 31 }], 36: [function(e, l, t) {
          (function(t2) {
            "use strict";
            var r, n, e2 = t2.MutationObserver || t2.WebKitMutationObserver;
            if (e2) {
              var i = 0, s = new e2(u), a = t2.document.createTextNode("");
              s.observe(a, { characterData: true }), r = function() {
                a.data = i = ++i % 2;
              };
            } else if (t2.setImmediate || void 0 === t2.MessageChannel) r = "document" in t2 && "onreadystatechange" in t2.document.createElement("script") ? function() {
              var e3 = t2.document.createElement("script");
              e3.onreadystatechange = function() {
                u(), e3.onreadystatechange = null, e3.parentNode.removeChild(e3), e3 = null;
              }, t2.document.documentElement.appendChild(e3);
            } : function() {
              setTimeout(u, 0);
            };
            else {
              var o = new t2.MessageChannel();
              o.port1.onmessage = u, r = function() {
                o.port2.postMessage(0);
              };
            }
            var h = [];
            function u() {
              var e3, t3;
              n = true;
              for (var r2 = h.length; r2; ) {
                for (t3 = h, h = [], e3 = -1; ++e3 < r2; ) t3[e3]();
                r2 = h.length;
              }
              n = false;
            }
            l.exports = function(e3) {
              1 !== h.push(e3) || n || r();
            };
          }).call(this, "undefined" != typeof global ? global : "undefined" != typeof self ? self : "undefined" != typeof window ? window : {});
        }, {}], 37: [function(e, t, r) {
          "use strict";
          var i = e("immediate");
          function u() {
          }
          var l = {}, s = ["REJECTED"], a = ["FULFILLED"], n = ["PENDING"];
          function o(e2) {
            if ("function" != typeof e2) throw new TypeError("resolver must be a function");
            this.state = n, this.queue = [], this.outcome = void 0, e2 !== u && d(this, e2);
          }
          function h(e2, t2, r2) {
            this.promise = e2, "function" == typeof t2 && (this.onFulfilled = t2, this.callFulfilled = this.otherCallFulfilled), "function" == typeof r2 && (this.onRejected = r2, this.callRejected = this.otherCallRejected);
          }
          function f(t2, r2, n2) {
            i(function() {
              var e2;
              try {
                e2 = r2(n2);
              } catch (e3) {
                return l.reject(t2, e3);
              }
              e2 === t2 ? l.reject(t2, new TypeError("Cannot resolve promise with itself")) : l.resolve(t2, e2);
            });
          }
          function c(e2) {
            var t2 = e2 && e2.then;
            if (e2 && ("object" == typeof e2 || "function" == typeof e2) && "function" == typeof t2) return function() {
              t2.apply(e2, arguments);
            };
          }
          function d(t2, e2) {
            var r2 = false;
            function n2(e3) {
              r2 || (r2 = true, l.reject(t2, e3));
            }
            function i2(e3) {
              r2 || (r2 = true, l.resolve(t2, e3));
            }
            var s2 = p(function() {
              e2(i2, n2);
            });
            "error" === s2.status && n2(s2.value);
          }
          function p(e2, t2) {
            var r2 = {};
            try {
              r2.value = e2(t2), r2.status = "success";
            } catch (e3) {
              r2.status = "error", r2.value = e3;
            }
            return r2;
          }
          (t.exports = o).prototype.finally = function(t2) {
            if ("function" != typeof t2) return this;
            var r2 = this.constructor;
            return this.then(function(e2) {
              return r2.resolve(t2()).then(function() {
                return e2;
              });
            }, function(e2) {
              return r2.resolve(t2()).then(function() {
                throw e2;
              });
            });
          }, o.prototype.catch = function(e2) {
            return this.then(null, e2);
          }, o.prototype.then = function(e2, t2) {
            if ("function" != typeof e2 && this.state === a || "function" != typeof t2 && this.state === s) return this;
            var r2 = new this.constructor(u);
            this.state !== n ? f(r2, this.state === a ? e2 : t2, this.outcome) : this.queue.push(new h(r2, e2, t2));
            return r2;
          }, h.prototype.callFulfilled = function(e2) {
            l.resolve(this.promise, e2);
          }, h.prototype.otherCallFulfilled = function(e2) {
            f(this.promise, this.onFulfilled, e2);
          }, h.prototype.callRejected = function(e2) {
            l.reject(this.promise, e2);
          }, h.prototype.otherCallRejected = function(e2) {
            f(this.promise, this.onRejected, e2);
          }, l.resolve = function(e2, t2) {
            var r2 = p(c, t2);
            if ("error" === r2.status) return l.reject(e2, r2.value);
            var n2 = r2.value;
            if (n2) d(e2, n2);
            else {
              e2.state = a, e2.outcome = t2;
              for (var i2 = -1, s2 = e2.queue.length; ++i2 < s2; ) e2.queue[i2].callFulfilled(t2);
            }
            return e2;
          }, l.reject = function(e2, t2) {
            e2.state = s, e2.outcome = t2;
            for (var r2 = -1, n2 = e2.queue.length; ++r2 < n2; ) e2.queue[r2].callRejected(t2);
            return e2;
          }, o.resolve = function(e2) {
            if (e2 instanceof this) return e2;
            return l.resolve(new this(u), e2);
          }, o.reject = function(e2) {
            var t2 = new this(u);
            return l.reject(t2, e2);
          }, o.all = function(e2) {
            var r2 = this;
            if ("[object Array]" !== Object.prototype.toString.call(e2)) return this.reject(new TypeError("must be an array"));
            var n2 = e2.length, i2 = false;
            if (!n2) return this.resolve([]);
            var s2 = new Array(n2), a2 = 0, t2 = -1, o2 = new this(u);
            for (; ++t2 < n2; ) h2(e2[t2], t2);
            return o2;
            function h2(e3, t3) {
              r2.resolve(e3).then(function(e4) {
                s2[t3] = e4, ++a2 !== n2 || i2 || (i2 = true, l.resolve(o2, s2));
              }, function(e4) {
                i2 || (i2 = true, l.reject(o2, e4));
              });
            }
          }, o.race = function(e2) {
            var t2 = this;
            if ("[object Array]" !== Object.prototype.toString.call(e2)) return this.reject(new TypeError("must be an array"));
            var r2 = e2.length, n2 = false;
            if (!r2) return this.resolve([]);
            var i2 = -1, s2 = new this(u);
            for (; ++i2 < r2; ) a2 = e2[i2], t2.resolve(a2).then(function(e3) {
              n2 || (n2 = true, l.resolve(s2, e3));
            }, function(e3) {
              n2 || (n2 = true, l.reject(s2, e3));
            });
            var a2;
            return s2;
          };
        }, { immediate: 36 }], 38: [function(e, t, r) {
          "use strict";
          var n = {};
          (0, e("./lib/utils/common").assign)(n, e("./lib/deflate"), e("./lib/inflate"), e("./lib/zlib/constants")), t.exports = n;
        }, { "./lib/deflate": 39, "./lib/inflate": 40, "./lib/utils/common": 41, "./lib/zlib/constants": 44 }], 39: [function(e, t, r) {
          "use strict";
          var a = e("./zlib/deflate"), o = e("./utils/common"), h = e("./utils/strings"), i = e("./zlib/messages"), s = e("./zlib/zstream"), u = Object.prototype.toString, l = 0, f = -1, c = 0, d = 8;
          function p(e2) {
            if (!(this instanceof p)) return new p(e2);
            this.options = o.assign({ level: f, method: d, chunkSize: 16384, windowBits: 15, memLevel: 8, strategy: c, to: "" }, e2 || {});
            var t2 = this.options;
            t2.raw && 0 < t2.windowBits ? t2.windowBits = -t2.windowBits : t2.gzip && 0 < t2.windowBits && t2.windowBits < 16 && (t2.windowBits += 16), this.err = 0, this.msg = "", this.ended = false, this.chunks = [], this.strm = new s(), this.strm.avail_out = 0;
            var r2 = a.deflateInit2(this.strm, t2.level, t2.method, t2.windowBits, t2.memLevel, t2.strategy);
            if (r2 !== l) throw new Error(i[r2]);
            if (t2.header && a.deflateSetHeader(this.strm, t2.header), t2.dictionary) {
              var n2;
              if (n2 = "string" == typeof t2.dictionary ? h.string2buf(t2.dictionary) : "[object ArrayBuffer]" === u.call(t2.dictionary) ? new Uint8Array(t2.dictionary) : t2.dictionary, (r2 = a.deflateSetDictionary(this.strm, n2)) !== l) throw new Error(i[r2]);
              this._dict_set = true;
            }
          }
          function n(e2, t2) {
            var r2 = new p(t2);
            if (r2.push(e2, true), r2.err) throw r2.msg || i[r2.err];
            return r2.result;
          }
          p.prototype.push = function(e2, t2) {
            var r2, n2, i2 = this.strm, s2 = this.options.chunkSize;
            if (this.ended) return false;
            n2 = t2 === ~~t2 ? t2 : true === t2 ? 4 : 0, "string" == typeof e2 ? i2.input = h.string2buf(e2) : "[object ArrayBuffer]" === u.call(e2) ? i2.input = new Uint8Array(e2) : i2.input = e2, i2.next_in = 0, i2.avail_in = i2.input.length;
            do {
              if (0 === i2.avail_out && (i2.output = new o.Buf8(s2), i2.next_out = 0, i2.avail_out = s2), 1 !== (r2 = a.deflate(i2, n2)) && r2 !== l) return this.onEnd(r2), !(this.ended = true);
              0 !== i2.avail_out && (0 !== i2.avail_in || 4 !== n2 && 2 !== n2) || ("string" === this.options.to ? this.onData(h.buf2binstring(o.shrinkBuf(i2.output, i2.next_out))) : this.onData(o.shrinkBuf(i2.output, i2.next_out)));
            } while ((0 < i2.avail_in || 0 === i2.avail_out) && 1 !== r2);
            return 4 === n2 ? (r2 = a.deflateEnd(this.strm), this.onEnd(r2), this.ended = true, r2 === l) : 2 !== n2 || (this.onEnd(l), !(i2.avail_out = 0));
          }, p.prototype.onData = function(e2) {
            this.chunks.push(e2);
          }, p.prototype.onEnd = function(e2) {
            e2 === l && ("string" === this.options.to ? this.result = this.chunks.join("") : this.result = o.flattenChunks(this.chunks)), this.chunks = [], this.err = e2, this.msg = this.strm.msg;
          }, r.Deflate = p, r.deflate = n, r.deflateRaw = function(e2, t2) {
            return (t2 = t2 || {}).raw = true, n(e2, t2);
          }, r.gzip = function(e2, t2) {
            return (t2 = t2 || {}).gzip = true, n(e2, t2);
          };
        }, { "./utils/common": 41, "./utils/strings": 42, "./zlib/deflate": 46, "./zlib/messages": 51, "./zlib/zstream": 53 }], 40: [function(e, t, r) {
          "use strict";
          var c = e("./zlib/inflate"), d = e("./utils/common"), p = e("./utils/strings"), m = e("./zlib/constants"), n = e("./zlib/messages"), i = e("./zlib/zstream"), s = e("./zlib/gzheader"), _ = Object.prototype.toString;
          function a(e2) {
            if (!(this instanceof a)) return new a(e2);
            this.options = d.assign({ chunkSize: 16384, windowBits: 0, to: "" }, e2 || {});
            var t2 = this.options;
            t2.raw && 0 <= t2.windowBits && t2.windowBits < 16 && (t2.windowBits = -t2.windowBits, 0 === t2.windowBits && (t2.windowBits = -15)), !(0 <= t2.windowBits && t2.windowBits < 16) || e2 && e2.windowBits || (t2.windowBits += 32), 15 < t2.windowBits && t2.windowBits < 48 && 0 == (15 & t2.windowBits) && (t2.windowBits |= 15), this.err = 0, this.msg = "", this.ended = false, this.chunks = [], this.strm = new i(), this.strm.avail_out = 0;
            var r2 = c.inflateInit2(this.strm, t2.windowBits);
            if (r2 !== m.Z_OK) throw new Error(n[r2]);
            this.header = new s(), c.inflateGetHeader(this.strm, this.header);
          }
          function o(e2, t2) {
            var r2 = new a(t2);
            if (r2.push(e2, true), r2.err) throw r2.msg || n[r2.err];
            return r2.result;
          }
          a.prototype.push = function(e2, t2) {
            var r2, n2, i2, s2, a2, o2, h = this.strm, u = this.options.chunkSize, l = this.options.dictionary, f = false;
            if (this.ended) return false;
            n2 = t2 === ~~t2 ? t2 : true === t2 ? m.Z_FINISH : m.Z_NO_FLUSH, "string" == typeof e2 ? h.input = p.binstring2buf(e2) : "[object ArrayBuffer]" === _.call(e2) ? h.input = new Uint8Array(e2) : h.input = e2, h.next_in = 0, h.avail_in = h.input.length;
            do {
              if (0 === h.avail_out && (h.output = new d.Buf8(u), h.next_out = 0, h.avail_out = u), (r2 = c.inflate(h, m.Z_NO_FLUSH)) === m.Z_NEED_DICT && l && (o2 = "string" == typeof l ? p.string2buf(l) : "[object ArrayBuffer]" === _.call(l) ? new Uint8Array(l) : l, r2 = c.inflateSetDictionary(this.strm, o2)), r2 === m.Z_BUF_ERROR && true === f && (r2 = m.Z_OK, f = false), r2 !== m.Z_STREAM_END && r2 !== m.Z_OK) return this.onEnd(r2), !(this.ended = true);
              h.next_out && (0 !== h.avail_out && r2 !== m.Z_STREAM_END && (0 !== h.avail_in || n2 !== m.Z_FINISH && n2 !== m.Z_SYNC_FLUSH) || ("string" === this.options.to ? (i2 = p.utf8border(h.output, h.next_out), s2 = h.next_out - i2, a2 = p.buf2string(h.output, i2), h.next_out = s2, h.avail_out = u - s2, s2 && d.arraySet(h.output, h.output, i2, s2, 0), this.onData(a2)) : this.onData(d.shrinkBuf(h.output, h.next_out)))), 0 === h.avail_in && 0 === h.avail_out && (f = true);
            } while ((0 < h.avail_in || 0 === h.avail_out) && r2 !== m.Z_STREAM_END);
            return r2 === m.Z_STREAM_END && (n2 = m.Z_FINISH), n2 === m.Z_FINISH ? (r2 = c.inflateEnd(this.strm), this.onEnd(r2), this.ended = true, r2 === m.Z_OK) : n2 !== m.Z_SYNC_FLUSH || (this.onEnd(m.Z_OK), !(h.avail_out = 0));
          }, a.prototype.onData = function(e2) {
            this.chunks.push(e2);
          }, a.prototype.onEnd = function(e2) {
            e2 === m.Z_OK && ("string" === this.options.to ? this.result = this.chunks.join("") : this.result = d.flattenChunks(this.chunks)), this.chunks = [], this.err = e2, this.msg = this.strm.msg;
          }, r.Inflate = a, r.inflate = o, r.inflateRaw = function(e2, t2) {
            return (t2 = t2 || {}).raw = true, o(e2, t2);
          }, r.ungzip = o;
        }, { "./utils/common": 41, "./utils/strings": 42, "./zlib/constants": 44, "./zlib/gzheader": 47, "./zlib/inflate": 49, "./zlib/messages": 51, "./zlib/zstream": 53 }], 41: [function(e, t, r) {
          "use strict";
          var n = "undefined" != typeof Uint8Array && "undefined" != typeof Uint16Array && "undefined" != typeof Int32Array;
          r.assign = function(e2) {
            for (var t2 = Array.prototype.slice.call(arguments, 1); t2.length; ) {
              var r2 = t2.shift();
              if (r2) {
                if ("object" != typeof r2) throw new TypeError(r2 + "must be non-object");
                for (var n2 in r2) r2.hasOwnProperty(n2) && (e2[n2] = r2[n2]);
              }
            }
            return e2;
          }, r.shrinkBuf = function(e2, t2) {
            return e2.length === t2 ? e2 : e2.subarray ? e2.subarray(0, t2) : (e2.length = t2, e2);
          };
          var i = { arraySet: function(e2, t2, r2, n2, i2) {
            if (t2.subarray && e2.subarray) e2.set(t2.subarray(r2, r2 + n2), i2);
            else for (var s2 = 0; s2 < n2; s2++) e2[i2 + s2] = t2[r2 + s2];
          }, flattenChunks: function(e2) {
            var t2, r2, n2, i2, s2, a;
            for (t2 = n2 = 0, r2 = e2.length; t2 < r2; t2++) n2 += e2[t2].length;
            for (a = new Uint8Array(n2), t2 = i2 = 0, r2 = e2.length; t2 < r2; t2++) s2 = e2[t2], a.set(s2, i2), i2 += s2.length;
            return a;
          } }, s = { arraySet: function(e2, t2, r2, n2, i2) {
            for (var s2 = 0; s2 < n2; s2++) e2[i2 + s2] = t2[r2 + s2];
          }, flattenChunks: function(e2) {
            return [].concat.apply([], e2);
          } };
          r.setTyped = function(e2) {
            e2 ? (r.Buf8 = Uint8Array, r.Buf16 = Uint16Array, r.Buf32 = Int32Array, r.assign(r, i)) : (r.Buf8 = Array, r.Buf16 = Array, r.Buf32 = Array, r.assign(r, s));
          }, r.setTyped(n);
        }, {}], 42: [function(e, t, r) {
          "use strict";
          var h = e("./common"), i = true, s = true;
          try {
            String.fromCharCode.apply(null, [0]);
          } catch (e2) {
            i = false;
          }
          try {
            String.fromCharCode.apply(null, new Uint8Array(1));
          } catch (e2) {
            s = false;
          }
          for (var u = new h.Buf8(256), n = 0; n < 256; n++) u[n] = 252 <= n ? 6 : 248 <= n ? 5 : 240 <= n ? 4 : 224 <= n ? 3 : 192 <= n ? 2 : 1;
          function l(e2, t2) {
            if (t2 < 65537 && (e2.subarray && s || !e2.subarray && i)) return String.fromCharCode.apply(null, h.shrinkBuf(e2, t2));
            for (var r2 = "", n2 = 0; n2 < t2; n2++) r2 += String.fromCharCode(e2[n2]);
            return r2;
          }
          u[254] = u[254] = 1, r.string2buf = function(e2) {
            var t2, r2, n2, i2, s2, a = e2.length, o = 0;
            for (i2 = 0; i2 < a; i2++) 55296 == (64512 & (r2 = e2.charCodeAt(i2))) && i2 + 1 < a && 56320 == (64512 & (n2 = e2.charCodeAt(i2 + 1))) && (r2 = 65536 + (r2 - 55296 << 10) + (n2 - 56320), i2++), o += r2 < 128 ? 1 : r2 < 2048 ? 2 : r2 < 65536 ? 3 : 4;
            for (t2 = new h.Buf8(o), i2 = s2 = 0; s2 < o; i2++) 55296 == (64512 & (r2 = e2.charCodeAt(i2))) && i2 + 1 < a && 56320 == (64512 & (n2 = e2.charCodeAt(i2 + 1))) && (r2 = 65536 + (r2 - 55296 << 10) + (n2 - 56320), i2++), r2 < 128 ? t2[s2++] = r2 : (r2 < 2048 ? t2[s2++] = 192 | r2 >>> 6 : (r2 < 65536 ? t2[s2++] = 224 | r2 >>> 12 : (t2[s2++] = 240 | r2 >>> 18, t2[s2++] = 128 | r2 >>> 12 & 63), t2[s2++] = 128 | r2 >>> 6 & 63), t2[s2++] = 128 | 63 & r2);
            return t2;
          }, r.buf2binstring = function(e2) {
            return l(e2, e2.length);
          }, r.binstring2buf = function(e2) {
            for (var t2 = new h.Buf8(e2.length), r2 = 0, n2 = t2.length; r2 < n2; r2++) t2[r2] = e2.charCodeAt(r2);
            return t2;
          }, r.buf2string = function(e2, t2) {
            var r2, n2, i2, s2, a = t2 || e2.length, o = new Array(2 * a);
            for (r2 = n2 = 0; r2 < a; ) if ((i2 = e2[r2++]) < 128) o[n2++] = i2;
            else if (4 < (s2 = u[i2])) o[n2++] = 65533, r2 += s2 - 1;
            else {
              for (i2 &= 2 === s2 ? 31 : 3 === s2 ? 15 : 7; 1 < s2 && r2 < a; ) i2 = i2 << 6 | 63 & e2[r2++], s2--;
              1 < s2 ? o[n2++] = 65533 : i2 < 65536 ? o[n2++] = i2 : (i2 -= 65536, o[n2++] = 55296 | i2 >> 10 & 1023, o[n2++] = 56320 | 1023 & i2);
            }
            return l(o, n2);
          }, r.utf8border = function(e2, t2) {
            var r2;
            for ((t2 = t2 || e2.length) > e2.length && (t2 = e2.length), r2 = t2 - 1; 0 <= r2 && 128 == (192 & e2[r2]); ) r2--;
            return r2 < 0 ? t2 : 0 === r2 ? t2 : r2 + u[e2[r2]] > t2 ? r2 : t2;
          };
        }, { "./common": 41 }], 43: [function(e, t, r) {
          "use strict";
          t.exports = function(e2, t2, r2, n) {
            for (var i = 65535 & e2 | 0, s = e2 >>> 16 & 65535 | 0, a = 0; 0 !== r2; ) {
              for (r2 -= a = 2e3 < r2 ? 2e3 : r2; s = s + (i = i + t2[n++] | 0) | 0, --a; ) ;
              i %= 65521, s %= 65521;
            }
            return i | s << 16 | 0;
          };
        }, {}], 44: [function(e, t, r) {
          "use strict";
          t.exports = { Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5, Z_TREES: 6, Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_BUF_ERROR: -5, Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1, Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0, Z_BINARY: 0, Z_TEXT: 1, Z_UNKNOWN: 2, Z_DEFLATED: 8 };
        }, {}], 45: [function(e, t, r) {
          "use strict";
          var o = (function() {
            for (var e2, t2 = [], r2 = 0; r2 < 256; r2++) {
              e2 = r2;
              for (var n = 0; n < 8; n++) e2 = 1 & e2 ? 3988292384 ^ e2 >>> 1 : e2 >>> 1;
              t2[r2] = e2;
            }
            return t2;
          })();
          t.exports = function(e2, t2, r2, n) {
            var i = o, s = n + r2;
            e2 ^= -1;
            for (var a = n; a < s; a++) e2 = e2 >>> 8 ^ i[255 & (e2 ^ t2[a])];
            return -1 ^ e2;
          };
        }, {}], 46: [function(e, t, r) {
          "use strict";
          var h, c = e("../utils/common"), u = e("./trees"), d = e("./adler32"), p = e("./crc32"), n = e("./messages"), l = 0, f = 4, m = 0, _ = -2, g = -1, b = 4, i = 2, v = 8, y = 9, s = 286, a = 30, o = 19, w = 2 * s + 1, k = 15, x = 3, S = 258, z = S + x + 1, C = 42, E = 113, A = 1, I = 2, O = 3, B = 4;
          function R(e2, t2) {
            return e2.msg = n[t2], t2;
          }
          function T(e2) {
            return (e2 << 1) - (4 < e2 ? 9 : 0);
          }
          function D(e2) {
            for (var t2 = e2.length; 0 <= --t2; ) e2[t2] = 0;
          }
          function F(e2) {
            var t2 = e2.state, r2 = t2.pending;
            r2 > e2.avail_out && (r2 = e2.avail_out), 0 !== r2 && (c.arraySet(e2.output, t2.pending_buf, t2.pending_out, r2, e2.next_out), e2.next_out += r2, t2.pending_out += r2, e2.total_out += r2, e2.avail_out -= r2, t2.pending -= r2, 0 === t2.pending && (t2.pending_out = 0));
          }
          function N(e2, t2) {
            u._tr_flush_block(e2, 0 <= e2.block_start ? e2.block_start : -1, e2.strstart - e2.block_start, t2), e2.block_start = e2.strstart, F(e2.strm);
          }
          function U(e2, t2) {
            e2.pending_buf[e2.pending++] = t2;
          }
          function P(e2, t2) {
            e2.pending_buf[e2.pending++] = t2 >>> 8 & 255, e2.pending_buf[e2.pending++] = 255 & t2;
          }
          function L(e2, t2) {
            var r2, n2, i2 = e2.max_chain_length, s2 = e2.strstart, a2 = e2.prev_length, o2 = e2.nice_match, h2 = e2.strstart > e2.w_size - z ? e2.strstart - (e2.w_size - z) : 0, u2 = e2.window, l2 = e2.w_mask, f2 = e2.prev, c2 = e2.strstart + S, d2 = u2[s2 + a2 - 1], p2 = u2[s2 + a2];
            e2.prev_length >= e2.good_match && (i2 >>= 2), o2 > e2.lookahead && (o2 = e2.lookahead);
            do {
              if (u2[(r2 = t2) + a2] === p2 && u2[r2 + a2 - 1] === d2 && u2[r2] === u2[s2] && u2[++r2] === u2[s2 + 1]) {
                s2 += 2, r2++;
                do {
                } while (u2[++s2] === u2[++r2] && u2[++s2] === u2[++r2] && u2[++s2] === u2[++r2] && u2[++s2] === u2[++r2] && u2[++s2] === u2[++r2] && u2[++s2] === u2[++r2] && u2[++s2] === u2[++r2] && u2[++s2] === u2[++r2] && s2 < c2);
                if (n2 = S - (c2 - s2), s2 = c2 - S, a2 < n2) {
                  if (e2.match_start = t2, o2 <= (a2 = n2)) break;
                  d2 = u2[s2 + a2 - 1], p2 = u2[s2 + a2];
                }
              }
            } while ((t2 = f2[t2 & l2]) > h2 && 0 != --i2);
            return a2 <= e2.lookahead ? a2 : e2.lookahead;
          }
          function j(e2) {
            var t2, r2, n2, i2, s2, a2, o2, h2, u2, l2, f2 = e2.w_size;
            do {
              if (i2 = e2.window_size - e2.lookahead - e2.strstart, e2.strstart >= f2 + (f2 - z)) {
                for (c.arraySet(e2.window, e2.window, f2, f2, 0), e2.match_start -= f2, e2.strstart -= f2, e2.block_start -= f2, t2 = r2 = e2.hash_size; n2 = e2.head[--t2], e2.head[t2] = f2 <= n2 ? n2 - f2 : 0, --r2; ) ;
                for (t2 = r2 = f2; n2 = e2.prev[--t2], e2.prev[t2] = f2 <= n2 ? n2 - f2 : 0, --r2; ) ;
                i2 += f2;
              }
              if (0 === e2.strm.avail_in) break;
              if (a2 = e2.strm, o2 = e2.window, h2 = e2.strstart + e2.lookahead, u2 = i2, l2 = void 0, l2 = a2.avail_in, u2 < l2 && (l2 = u2), r2 = 0 === l2 ? 0 : (a2.avail_in -= l2, c.arraySet(o2, a2.input, a2.next_in, l2, h2), 1 === a2.state.wrap ? a2.adler = d(a2.adler, o2, l2, h2) : 2 === a2.state.wrap && (a2.adler = p(a2.adler, o2, l2, h2)), a2.next_in += l2, a2.total_in += l2, l2), e2.lookahead += r2, e2.lookahead + e2.insert >= x) for (s2 = e2.strstart - e2.insert, e2.ins_h = e2.window[s2], e2.ins_h = (e2.ins_h << e2.hash_shift ^ e2.window[s2 + 1]) & e2.hash_mask; e2.insert && (e2.ins_h = (e2.ins_h << e2.hash_shift ^ e2.window[s2 + x - 1]) & e2.hash_mask, e2.prev[s2 & e2.w_mask] = e2.head[e2.ins_h], e2.head[e2.ins_h] = s2, s2++, e2.insert--, !(e2.lookahead + e2.insert < x)); ) ;
            } while (e2.lookahead < z && 0 !== e2.strm.avail_in);
          }
          function Z(e2, t2) {
            for (var r2, n2; ; ) {
              if (e2.lookahead < z) {
                if (j(e2), e2.lookahead < z && t2 === l) return A;
                if (0 === e2.lookahead) break;
              }
              if (r2 = 0, e2.lookahead >= x && (e2.ins_h = (e2.ins_h << e2.hash_shift ^ e2.window[e2.strstart + x - 1]) & e2.hash_mask, r2 = e2.prev[e2.strstart & e2.w_mask] = e2.head[e2.ins_h], e2.head[e2.ins_h] = e2.strstart), 0 !== r2 && e2.strstart - r2 <= e2.w_size - z && (e2.match_length = L(e2, r2)), e2.match_length >= x) if (n2 = u._tr_tally(e2, e2.strstart - e2.match_start, e2.match_length - x), e2.lookahead -= e2.match_length, e2.match_length <= e2.max_lazy_match && e2.lookahead >= x) {
                for (e2.match_length--; e2.strstart++, e2.ins_h = (e2.ins_h << e2.hash_shift ^ e2.window[e2.strstart + x - 1]) & e2.hash_mask, r2 = e2.prev[e2.strstart & e2.w_mask] = e2.head[e2.ins_h], e2.head[e2.ins_h] = e2.strstart, 0 != --e2.match_length; ) ;
                e2.strstart++;
              } else e2.strstart += e2.match_length, e2.match_length = 0, e2.ins_h = e2.window[e2.strstart], e2.ins_h = (e2.ins_h << e2.hash_shift ^ e2.window[e2.strstart + 1]) & e2.hash_mask;
              else n2 = u._tr_tally(e2, 0, e2.window[e2.strstart]), e2.lookahead--, e2.strstart++;
              if (n2 && (N(e2, false), 0 === e2.strm.avail_out)) return A;
            }
            return e2.insert = e2.strstart < x - 1 ? e2.strstart : x - 1, t2 === f ? (N(e2, true), 0 === e2.strm.avail_out ? O : B) : e2.last_lit && (N(e2, false), 0 === e2.strm.avail_out) ? A : I;
          }
          function W(e2, t2) {
            for (var r2, n2, i2; ; ) {
              if (e2.lookahead < z) {
                if (j(e2), e2.lookahead < z && t2 === l) return A;
                if (0 === e2.lookahead) break;
              }
              if (r2 = 0, e2.lookahead >= x && (e2.ins_h = (e2.ins_h << e2.hash_shift ^ e2.window[e2.strstart + x - 1]) & e2.hash_mask, r2 = e2.prev[e2.strstart & e2.w_mask] = e2.head[e2.ins_h], e2.head[e2.ins_h] = e2.strstart), e2.prev_length = e2.match_length, e2.prev_match = e2.match_start, e2.match_length = x - 1, 0 !== r2 && e2.prev_length < e2.max_lazy_match && e2.strstart - r2 <= e2.w_size - z && (e2.match_length = L(e2, r2), e2.match_length <= 5 && (1 === e2.strategy || e2.match_length === x && 4096 < e2.strstart - e2.match_start) && (e2.match_length = x - 1)), e2.prev_length >= x && e2.match_length <= e2.prev_length) {
                for (i2 = e2.strstart + e2.lookahead - x, n2 = u._tr_tally(e2, e2.strstart - 1 - e2.prev_match, e2.prev_length - x), e2.lookahead -= e2.prev_length - 1, e2.prev_length -= 2; ++e2.strstart <= i2 && (e2.ins_h = (e2.ins_h << e2.hash_shift ^ e2.window[e2.strstart + x - 1]) & e2.hash_mask, r2 = e2.prev[e2.strstart & e2.w_mask] = e2.head[e2.ins_h], e2.head[e2.ins_h] = e2.strstart), 0 != --e2.prev_length; ) ;
                if (e2.match_available = 0, e2.match_length = x - 1, e2.strstart++, n2 && (N(e2, false), 0 === e2.strm.avail_out)) return A;
              } else if (e2.match_available) {
                if ((n2 = u._tr_tally(e2, 0, e2.window[e2.strstart - 1])) && N(e2, false), e2.strstart++, e2.lookahead--, 0 === e2.strm.avail_out) return A;
              } else e2.match_available = 1, e2.strstart++, e2.lookahead--;
            }
            return e2.match_available && (n2 = u._tr_tally(e2, 0, e2.window[e2.strstart - 1]), e2.match_available = 0), e2.insert = e2.strstart < x - 1 ? e2.strstart : x - 1, t2 === f ? (N(e2, true), 0 === e2.strm.avail_out ? O : B) : e2.last_lit && (N(e2, false), 0 === e2.strm.avail_out) ? A : I;
          }
          function M(e2, t2, r2, n2, i2) {
            this.good_length = e2, this.max_lazy = t2, this.nice_length = r2, this.max_chain = n2, this.func = i2;
          }
          function H() {
            this.strm = null, this.status = 0, this.pending_buf = null, this.pending_buf_size = 0, this.pending_out = 0, this.pending = 0, this.wrap = 0, this.gzhead = null, this.gzindex = 0, this.method = v, this.last_flush = -1, this.w_size = 0, this.w_bits = 0, this.w_mask = 0, this.window = null, this.window_size = 0, this.prev = null, this.head = null, this.ins_h = 0, this.hash_size = 0, this.hash_bits = 0, this.hash_mask = 0, this.hash_shift = 0, this.block_start = 0, this.match_length = 0, this.prev_match = 0, this.match_available = 0, this.strstart = 0, this.match_start = 0, this.lookahead = 0, this.prev_length = 0, this.max_chain_length = 0, this.max_lazy_match = 0, this.level = 0, this.strategy = 0, this.good_match = 0, this.nice_match = 0, this.dyn_ltree = new c.Buf16(2 * w), this.dyn_dtree = new c.Buf16(2 * (2 * a + 1)), this.bl_tree = new c.Buf16(2 * (2 * o + 1)), D(this.dyn_ltree), D(this.dyn_dtree), D(this.bl_tree), this.l_desc = null, this.d_desc = null, this.bl_desc = null, this.bl_count = new c.Buf16(k + 1), this.heap = new c.Buf16(2 * s + 1), D(this.heap), this.heap_len = 0, this.heap_max = 0, this.depth = new c.Buf16(2 * s + 1), D(this.depth), this.l_buf = 0, this.lit_bufsize = 0, this.last_lit = 0, this.d_buf = 0, this.opt_len = 0, this.static_len = 0, this.matches = 0, this.insert = 0, this.bi_buf = 0, this.bi_valid = 0;
          }
          function G(e2) {
            var t2;
            return e2 && e2.state ? (e2.total_in = e2.total_out = 0, e2.data_type = i, (t2 = e2.state).pending = 0, t2.pending_out = 0, t2.wrap < 0 && (t2.wrap = -t2.wrap), t2.status = t2.wrap ? C : E, e2.adler = 2 === t2.wrap ? 0 : 1, t2.last_flush = l, u._tr_init(t2), m) : R(e2, _);
          }
          function K(e2) {
            var t2 = G(e2);
            return t2 === m && (function(e3) {
              e3.window_size = 2 * e3.w_size, D(e3.head), e3.max_lazy_match = h[e3.level].max_lazy, e3.good_match = h[e3.level].good_length, e3.nice_match = h[e3.level].nice_length, e3.max_chain_length = h[e3.level].max_chain, e3.strstart = 0, e3.block_start = 0, e3.lookahead = 0, e3.insert = 0, e3.match_length = e3.prev_length = x - 1, e3.match_available = 0, e3.ins_h = 0;
            })(e2.state), t2;
          }
          function Y(e2, t2, r2, n2, i2, s2) {
            if (!e2) return _;
            var a2 = 1;
            if (t2 === g && (t2 = 6), n2 < 0 ? (a2 = 0, n2 = -n2) : 15 < n2 && (a2 = 2, n2 -= 16), i2 < 1 || y < i2 || r2 !== v || n2 < 8 || 15 < n2 || t2 < 0 || 9 < t2 || s2 < 0 || b < s2) return R(e2, _);
            8 === n2 && (n2 = 9);
            var o2 = new H();
            return (e2.state = o2).strm = e2, o2.wrap = a2, o2.gzhead = null, o2.w_bits = n2, o2.w_size = 1 << o2.w_bits, o2.w_mask = o2.w_size - 1, o2.hash_bits = i2 + 7, o2.hash_size = 1 << o2.hash_bits, o2.hash_mask = o2.hash_size - 1, o2.hash_shift = ~~((o2.hash_bits + x - 1) / x), o2.window = new c.Buf8(2 * o2.w_size), o2.head = new c.Buf16(o2.hash_size), o2.prev = new c.Buf16(o2.w_size), o2.lit_bufsize = 1 << i2 + 6, o2.pending_buf_size = 4 * o2.lit_bufsize, o2.pending_buf = new c.Buf8(o2.pending_buf_size), o2.d_buf = 1 * o2.lit_bufsize, o2.l_buf = 3 * o2.lit_bufsize, o2.level = t2, o2.strategy = s2, o2.method = r2, K(e2);
          }
          h = [new M(0, 0, 0, 0, function(e2, t2) {
            var r2 = 65535;
            for (r2 > e2.pending_buf_size - 5 && (r2 = e2.pending_buf_size - 5); ; ) {
              if (e2.lookahead <= 1) {
                if (j(e2), 0 === e2.lookahead && t2 === l) return A;
                if (0 === e2.lookahead) break;
              }
              e2.strstart += e2.lookahead, e2.lookahead = 0;
              var n2 = e2.block_start + r2;
              if ((0 === e2.strstart || e2.strstart >= n2) && (e2.lookahead = e2.strstart - n2, e2.strstart = n2, N(e2, false), 0 === e2.strm.avail_out)) return A;
              if (e2.strstart - e2.block_start >= e2.w_size - z && (N(e2, false), 0 === e2.strm.avail_out)) return A;
            }
            return e2.insert = 0, t2 === f ? (N(e2, true), 0 === e2.strm.avail_out ? O : B) : (e2.strstart > e2.block_start && (N(e2, false), e2.strm.avail_out), A);
          }), new M(4, 4, 8, 4, Z), new M(4, 5, 16, 8, Z), new M(4, 6, 32, 32, Z), new M(4, 4, 16, 16, W), new M(8, 16, 32, 32, W), new M(8, 16, 128, 128, W), new M(8, 32, 128, 256, W), new M(32, 128, 258, 1024, W), new M(32, 258, 258, 4096, W)], r.deflateInit = function(e2, t2) {
            return Y(e2, t2, v, 15, 8, 0);
          }, r.deflateInit2 = Y, r.deflateReset = K, r.deflateResetKeep = G, r.deflateSetHeader = function(e2, t2) {
            return e2 && e2.state ? 2 !== e2.state.wrap ? _ : (e2.state.gzhead = t2, m) : _;
          }, r.deflate = function(e2, t2) {
            var r2, n2, i2, s2;
            if (!e2 || !e2.state || 5 < t2 || t2 < 0) return e2 ? R(e2, _) : _;
            if (n2 = e2.state, !e2.output || !e2.input && 0 !== e2.avail_in || 666 === n2.status && t2 !== f) return R(e2, 0 === e2.avail_out ? -5 : _);
            if (n2.strm = e2, r2 = n2.last_flush, n2.last_flush = t2, n2.status === C) if (2 === n2.wrap) e2.adler = 0, U(n2, 31), U(n2, 139), U(n2, 8), n2.gzhead ? (U(n2, (n2.gzhead.text ? 1 : 0) + (n2.gzhead.hcrc ? 2 : 0) + (n2.gzhead.extra ? 4 : 0) + (n2.gzhead.name ? 8 : 0) + (n2.gzhead.comment ? 16 : 0)), U(n2, 255 & n2.gzhead.time), U(n2, n2.gzhead.time >> 8 & 255), U(n2, n2.gzhead.time >> 16 & 255), U(n2, n2.gzhead.time >> 24 & 255), U(n2, 9 === n2.level ? 2 : 2 <= n2.strategy || n2.level < 2 ? 4 : 0), U(n2, 255 & n2.gzhead.os), n2.gzhead.extra && n2.gzhead.extra.length && (U(n2, 255 & n2.gzhead.extra.length), U(n2, n2.gzhead.extra.length >> 8 & 255)), n2.gzhead.hcrc && (e2.adler = p(e2.adler, n2.pending_buf, n2.pending, 0)), n2.gzindex = 0, n2.status = 69) : (U(n2, 0), U(n2, 0), U(n2, 0), U(n2, 0), U(n2, 0), U(n2, 9 === n2.level ? 2 : 2 <= n2.strategy || n2.level < 2 ? 4 : 0), U(n2, 3), n2.status = E);
            else {
              var a2 = v + (n2.w_bits - 8 << 4) << 8;
              a2 |= (2 <= n2.strategy || n2.level < 2 ? 0 : n2.level < 6 ? 1 : 6 === n2.level ? 2 : 3) << 6, 0 !== n2.strstart && (a2 |= 32), a2 += 31 - a2 % 31, n2.status = E, P(n2, a2), 0 !== n2.strstart && (P(n2, e2.adler >>> 16), P(n2, 65535 & e2.adler)), e2.adler = 1;
            }
            if (69 === n2.status) if (n2.gzhead.extra) {
              for (i2 = n2.pending; n2.gzindex < (65535 & n2.gzhead.extra.length) && (n2.pending !== n2.pending_buf_size || (n2.gzhead.hcrc && n2.pending > i2 && (e2.adler = p(e2.adler, n2.pending_buf, n2.pending - i2, i2)), F(e2), i2 = n2.pending, n2.pending !== n2.pending_buf_size)); ) U(n2, 255 & n2.gzhead.extra[n2.gzindex]), n2.gzindex++;
              n2.gzhead.hcrc && n2.pending > i2 && (e2.adler = p(e2.adler, n2.pending_buf, n2.pending - i2, i2)), n2.gzindex === n2.gzhead.extra.length && (n2.gzindex = 0, n2.status = 73);
            } else n2.status = 73;
            if (73 === n2.status) if (n2.gzhead.name) {
              i2 = n2.pending;
              do {
                if (n2.pending === n2.pending_buf_size && (n2.gzhead.hcrc && n2.pending > i2 && (e2.adler = p(e2.adler, n2.pending_buf, n2.pending - i2, i2)), F(e2), i2 = n2.pending, n2.pending === n2.pending_buf_size)) {
                  s2 = 1;
                  break;
                }
                s2 = n2.gzindex < n2.gzhead.name.length ? 255 & n2.gzhead.name.charCodeAt(n2.gzindex++) : 0, U(n2, s2);
              } while (0 !== s2);
              n2.gzhead.hcrc && n2.pending > i2 && (e2.adler = p(e2.adler, n2.pending_buf, n2.pending - i2, i2)), 0 === s2 && (n2.gzindex = 0, n2.status = 91);
            } else n2.status = 91;
            if (91 === n2.status) if (n2.gzhead.comment) {
              i2 = n2.pending;
              do {
                if (n2.pending === n2.pending_buf_size && (n2.gzhead.hcrc && n2.pending > i2 && (e2.adler = p(e2.adler, n2.pending_buf, n2.pending - i2, i2)), F(e2), i2 = n2.pending, n2.pending === n2.pending_buf_size)) {
                  s2 = 1;
                  break;
                }
                s2 = n2.gzindex < n2.gzhead.comment.length ? 255 & n2.gzhead.comment.charCodeAt(n2.gzindex++) : 0, U(n2, s2);
              } while (0 !== s2);
              n2.gzhead.hcrc && n2.pending > i2 && (e2.adler = p(e2.adler, n2.pending_buf, n2.pending - i2, i2)), 0 === s2 && (n2.status = 103);
            } else n2.status = 103;
            if (103 === n2.status && (n2.gzhead.hcrc ? (n2.pending + 2 > n2.pending_buf_size && F(e2), n2.pending + 2 <= n2.pending_buf_size && (U(n2, 255 & e2.adler), U(n2, e2.adler >> 8 & 255), e2.adler = 0, n2.status = E)) : n2.status = E), 0 !== n2.pending) {
              if (F(e2), 0 === e2.avail_out) return n2.last_flush = -1, m;
            } else if (0 === e2.avail_in && T(t2) <= T(r2) && t2 !== f) return R(e2, -5);
            if (666 === n2.status && 0 !== e2.avail_in) return R(e2, -5);
            if (0 !== e2.avail_in || 0 !== n2.lookahead || t2 !== l && 666 !== n2.status) {
              var o2 = 2 === n2.strategy ? (function(e3, t3) {
                for (var r3; ; ) {
                  if (0 === e3.lookahead && (j(e3), 0 === e3.lookahead)) {
                    if (t3 === l) return A;
                    break;
                  }
                  if (e3.match_length = 0, r3 = u._tr_tally(e3, 0, e3.window[e3.strstart]), e3.lookahead--, e3.strstart++, r3 && (N(e3, false), 0 === e3.strm.avail_out)) return A;
                }
                return e3.insert = 0, t3 === f ? (N(e3, true), 0 === e3.strm.avail_out ? O : B) : e3.last_lit && (N(e3, false), 0 === e3.strm.avail_out) ? A : I;
              })(n2, t2) : 3 === n2.strategy ? (function(e3, t3) {
                for (var r3, n3, i3, s3, a3 = e3.window; ; ) {
                  if (e3.lookahead <= S) {
                    if (j(e3), e3.lookahead <= S && t3 === l) return A;
                    if (0 === e3.lookahead) break;
                  }
                  if (e3.match_length = 0, e3.lookahead >= x && 0 < e3.strstart && (n3 = a3[i3 = e3.strstart - 1]) === a3[++i3] && n3 === a3[++i3] && n3 === a3[++i3]) {
                    s3 = e3.strstart + S;
                    do {
                    } while (n3 === a3[++i3] && n3 === a3[++i3] && n3 === a3[++i3] && n3 === a3[++i3] && n3 === a3[++i3] && n3 === a3[++i3] && n3 === a3[++i3] && n3 === a3[++i3] && i3 < s3);
                    e3.match_length = S - (s3 - i3), e3.match_length > e3.lookahead && (e3.match_length = e3.lookahead);
                  }
                  if (e3.match_length >= x ? (r3 = u._tr_tally(e3, 1, e3.match_length - x), e3.lookahead -= e3.match_length, e3.strstart += e3.match_length, e3.match_length = 0) : (r3 = u._tr_tally(e3, 0, e3.window[e3.strstart]), e3.lookahead--, e3.strstart++), r3 && (N(e3, false), 0 === e3.strm.avail_out)) return A;
                }
                return e3.insert = 0, t3 === f ? (N(e3, true), 0 === e3.strm.avail_out ? O : B) : e3.last_lit && (N(e3, false), 0 === e3.strm.avail_out) ? A : I;
              })(n2, t2) : h[n2.level].func(n2, t2);
              if (o2 !== O && o2 !== B || (n2.status = 666), o2 === A || o2 === O) return 0 === e2.avail_out && (n2.last_flush = -1), m;
              if (o2 === I && (1 === t2 ? u._tr_align(n2) : 5 !== t2 && (u._tr_stored_block(n2, 0, 0, false), 3 === t2 && (D(n2.head), 0 === n2.lookahead && (n2.strstart = 0, n2.block_start = 0, n2.insert = 0))), F(e2), 0 === e2.avail_out)) return n2.last_flush = -1, m;
            }
            return t2 !== f ? m : n2.wrap <= 0 ? 1 : (2 === n2.wrap ? (U(n2, 255 & e2.adler), U(n2, e2.adler >> 8 & 255), U(n2, e2.adler >> 16 & 255), U(n2, e2.adler >> 24 & 255), U(n2, 255 & e2.total_in), U(n2, e2.total_in >> 8 & 255), U(n2, e2.total_in >> 16 & 255), U(n2, e2.total_in >> 24 & 255)) : (P(n2, e2.adler >>> 16), P(n2, 65535 & e2.adler)), F(e2), 0 < n2.wrap && (n2.wrap = -n2.wrap), 0 !== n2.pending ? m : 1);
          }, r.deflateEnd = function(e2) {
            var t2;
            return e2 && e2.state ? (t2 = e2.state.status) !== C && 69 !== t2 && 73 !== t2 && 91 !== t2 && 103 !== t2 && t2 !== E && 666 !== t2 ? R(e2, _) : (e2.state = null, t2 === E ? R(e2, -3) : m) : _;
          }, r.deflateSetDictionary = function(e2, t2) {
            var r2, n2, i2, s2, a2, o2, h2, u2, l2 = t2.length;
            if (!e2 || !e2.state) return _;
            if (2 === (s2 = (r2 = e2.state).wrap) || 1 === s2 && r2.status !== C || r2.lookahead) return _;
            for (1 === s2 && (e2.adler = d(e2.adler, t2, l2, 0)), r2.wrap = 0, l2 >= r2.w_size && (0 === s2 && (D(r2.head), r2.strstart = 0, r2.block_start = 0, r2.insert = 0), u2 = new c.Buf8(r2.w_size), c.arraySet(u2, t2, l2 - r2.w_size, r2.w_size, 0), t2 = u2, l2 = r2.w_size), a2 = e2.avail_in, o2 = e2.next_in, h2 = e2.input, e2.avail_in = l2, e2.next_in = 0, e2.input = t2, j(r2); r2.lookahead >= x; ) {
              for (n2 = r2.strstart, i2 = r2.lookahead - (x - 1); r2.ins_h = (r2.ins_h << r2.hash_shift ^ r2.window[n2 + x - 1]) & r2.hash_mask, r2.prev[n2 & r2.w_mask] = r2.head[r2.ins_h], r2.head[r2.ins_h] = n2, n2++, --i2; ) ;
              r2.strstart = n2, r2.lookahead = x - 1, j(r2);
            }
            return r2.strstart += r2.lookahead, r2.block_start = r2.strstart, r2.insert = r2.lookahead, r2.lookahead = 0, r2.match_length = r2.prev_length = x - 1, r2.match_available = 0, e2.next_in = o2, e2.input = h2, e2.avail_in = a2, r2.wrap = s2, m;
          }, r.deflateInfo = "pako deflate (from Nodeca project)";
        }, { "../utils/common": 41, "./adler32": 43, "./crc32": 45, "./messages": 51, "./trees": 52 }], 47: [function(e, t, r) {
          "use strict";
          t.exports = function() {
            this.text = 0, this.time = 0, this.xflags = 0, this.os = 0, this.extra = null, this.extra_len = 0, this.name = "", this.comment = "", this.hcrc = 0, this.done = false;
          };
        }, {}], 48: [function(e, t, r) {
          "use strict";
          t.exports = function(e2, t2) {
            var r2, n, i, s, a, o, h, u, l, f, c, d, p, m, _, g, b, v, y, w, k, x, S, z, C;
            r2 = e2.state, n = e2.next_in, z = e2.input, i = n + (e2.avail_in - 5), s = e2.next_out, C = e2.output, a = s - (t2 - e2.avail_out), o = s + (e2.avail_out - 257), h = r2.dmax, u = r2.wsize, l = r2.whave, f = r2.wnext, c = r2.window, d = r2.hold, p = r2.bits, m = r2.lencode, _ = r2.distcode, g = (1 << r2.lenbits) - 1, b = (1 << r2.distbits) - 1;
            e: do {
              p < 15 && (d += z[n++] << p, p += 8, d += z[n++] << p, p += 8), v = m[d & g];
              t: for (; ; ) {
                if (d >>>= y = v >>> 24, p -= y, 0 === (y = v >>> 16 & 255)) C[s++] = 65535 & v;
                else {
                  if (!(16 & y)) {
                    if (0 == (64 & y)) {
                      v = m[(65535 & v) + (d & (1 << y) - 1)];
                      continue t;
                    }
                    if (32 & y) {
                      r2.mode = 12;
                      break e;
                    }
                    e2.msg = "invalid literal/length code", r2.mode = 30;
                    break e;
                  }
                  w = 65535 & v, (y &= 15) && (p < y && (d += z[n++] << p, p += 8), w += d & (1 << y) - 1, d >>>= y, p -= y), p < 15 && (d += z[n++] << p, p += 8, d += z[n++] << p, p += 8), v = _[d & b];
                  r: for (; ; ) {
                    if (d >>>= y = v >>> 24, p -= y, !(16 & (y = v >>> 16 & 255))) {
                      if (0 == (64 & y)) {
                        v = _[(65535 & v) + (d & (1 << y) - 1)];
                        continue r;
                      }
                      e2.msg = "invalid distance code", r2.mode = 30;
                      break e;
                    }
                    if (k = 65535 & v, p < (y &= 15) && (d += z[n++] << p, (p += 8) < y && (d += z[n++] << p, p += 8)), h < (k += d & (1 << y) - 1)) {
                      e2.msg = "invalid distance too far back", r2.mode = 30;
                      break e;
                    }
                    if (d >>>= y, p -= y, (y = s - a) < k) {
                      if (l < (y = k - y) && r2.sane) {
                        e2.msg = "invalid distance too far back", r2.mode = 30;
                        break e;
                      }
                      if (S = c, (x = 0) === f) {
                        if (x += u - y, y < w) {
                          for (w -= y; C[s++] = c[x++], --y; ) ;
                          x = s - k, S = C;
                        }
                      } else if (f < y) {
                        if (x += u + f - y, (y -= f) < w) {
                          for (w -= y; C[s++] = c[x++], --y; ) ;
                          if (x = 0, f < w) {
                            for (w -= y = f; C[s++] = c[x++], --y; ) ;
                            x = s - k, S = C;
                          }
                        }
                      } else if (x += f - y, y < w) {
                        for (w -= y; C[s++] = c[x++], --y; ) ;
                        x = s - k, S = C;
                      }
                      for (; 2 < w; ) C[s++] = S[x++], C[s++] = S[x++], C[s++] = S[x++], w -= 3;
                      w && (C[s++] = S[x++], 1 < w && (C[s++] = S[x++]));
                    } else {
                      for (x = s - k; C[s++] = C[x++], C[s++] = C[x++], C[s++] = C[x++], 2 < (w -= 3); ) ;
                      w && (C[s++] = C[x++], 1 < w && (C[s++] = C[x++]));
                    }
                    break;
                  }
                }
                break;
              }
            } while (n < i && s < o);
            n -= w = p >> 3, d &= (1 << (p -= w << 3)) - 1, e2.next_in = n, e2.next_out = s, e2.avail_in = n < i ? i - n + 5 : 5 - (n - i), e2.avail_out = s < o ? o - s + 257 : 257 - (s - o), r2.hold = d, r2.bits = p;
          };
        }, {}], 49: [function(e, t, r) {
          "use strict";
          var I = e("../utils/common"), O = e("./adler32"), B = e("./crc32"), R = e("./inffast"), T = e("./inftrees"), D = 1, F = 2, N = 0, U = -2, P = 1, n = 852, i = 592;
          function L(e2) {
            return (e2 >>> 24 & 255) + (e2 >>> 8 & 65280) + ((65280 & e2) << 8) + ((255 & e2) << 24);
          }
          function s() {
            this.mode = 0, this.last = false, this.wrap = 0, this.havedict = false, this.flags = 0, this.dmax = 0, this.check = 0, this.total = 0, this.head = null, this.wbits = 0, this.wsize = 0, this.whave = 0, this.wnext = 0, this.window = null, this.hold = 0, this.bits = 0, this.length = 0, this.offset = 0, this.extra = 0, this.lencode = null, this.distcode = null, this.lenbits = 0, this.distbits = 0, this.ncode = 0, this.nlen = 0, this.ndist = 0, this.have = 0, this.next = null, this.lens = new I.Buf16(320), this.work = new I.Buf16(288), this.lendyn = null, this.distdyn = null, this.sane = 0, this.back = 0, this.was = 0;
          }
          function a(e2) {
            var t2;
            return e2 && e2.state ? (t2 = e2.state, e2.total_in = e2.total_out = t2.total = 0, e2.msg = "", t2.wrap && (e2.adler = 1 & t2.wrap), t2.mode = P, t2.last = 0, t2.havedict = 0, t2.dmax = 32768, t2.head = null, t2.hold = 0, t2.bits = 0, t2.lencode = t2.lendyn = new I.Buf32(n), t2.distcode = t2.distdyn = new I.Buf32(i), t2.sane = 1, t2.back = -1, N) : U;
          }
          function o(e2) {
            var t2;
            return e2 && e2.state ? ((t2 = e2.state).wsize = 0, t2.whave = 0, t2.wnext = 0, a(e2)) : U;
          }
          function h(e2, t2) {
            var r2, n2;
            return e2 && e2.state ? (n2 = e2.state, t2 < 0 ? (r2 = 0, t2 = -t2) : (r2 = 1 + (t2 >> 4), t2 < 48 && (t2 &= 15)), t2 && (t2 < 8 || 15 < t2) ? U : (null !== n2.window && n2.wbits !== t2 && (n2.window = null), n2.wrap = r2, n2.wbits = t2, o(e2))) : U;
          }
          function u(e2, t2) {
            var r2, n2;
            return e2 ? (n2 = new s(), (e2.state = n2).window = null, (r2 = h(e2, t2)) !== N && (e2.state = null), r2) : U;
          }
          var l, f, c = true;
          function j(e2) {
            if (c) {
              var t2;
              for (l = new I.Buf32(512), f = new I.Buf32(32), t2 = 0; t2 < 144; ) e2.lens[t2++] = 8;
              for (; t2 < 256; ) e2.lens[t2++] = 9;
              for (; t2 < 280; ) e2.lens[t2++] = 7;
              for (; t2 < 288; ) e2.lens[t2++] = 8;
              for (T(D, e2.lens, 0, 288, l, 0, e2.work, { bits: 9 }), t2 = 0; t2 < 32; ) e2.lens[t2++] = 5;
              T(F, e2.lens, 0, 32, f, 0, e2.work, { bits: 5 }), c = false;
            }
            e2.lencode = l, e2.lenbits = 9, e2.distcode = f, e2.distbits = 5;
          }
          function Z(e2, t2, r2, n2) {
            var i2, s2 = e2.state;
            return null === s2.window && (s2.wsize = 1 << s2.wbits, s2.wnext = 0, s2.whave = 0, s2.window = new I.Buf8(s2.wsize)), n2 >= s2.wsize ? (I.arraySet(s2.window, t2, r2 - s2.wsize, s2.wsize, 0), s2.wnext = 0, s2.whave = s2.wsize) : (n2 < (i2 = s2.wsize - s2.wnext) && (i2 = n2), I.arraySet(s2.window, t2, r2 - n2, i2, s2.wnext), (n2 -= i2) ? (I.arraySet(s2.window, t2, r2 - n2, n2, 0), s2.wnext = n2, s2.whave = s2.wsize) : (s2.wnext += i2, s2.wnext === s2.wsize && (s2.wnext = 0), s2.whave < s2.wsize && (s2.whave += i2))), 0;
          }
          r.inflateReset = o, r.inflateReset2 = h, r.inflateResetKeep = a, r.inflateInit = function(e2) {
            return u(e2, 15);
          }, r.inflateInit2 = u, r.inflate = function(e2, t2) {
            var r2, n2, i2, s2, a2, o2, h2, u2, l2, f2, c2, d, p, m, _, g, b, v, y, w, k, x, S, z, C = 0, E = new I.Buf8(4), A = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
            if (!e2 || !e2.state || !e2.output || !e2.input && 0 !== e2.avail_in) return U;
            12 === (r2 = e2.state).mode && (r2.mode = 13), a2 = e2.next_out, i2 = e2.output, h2 = e2.avail_out, s2 = e2.next_in, n2 = e2.input, o2 = e2.avail_in, u2 = r2.hold, l2 = r2.bits, f2 = o2, c2 = h2, x = N;
            e: for (; ; ) switch (r2.mode) {
              case P:
                if (0 === r2.wrap) {
                  r2.mode = 13;
                  break;
                }
                for (; l2 < 16; ) {
                  if (0 === o2) break e;
                  o2--, u2 += n2[s2++] << l2, l2 += 8;
                }
                if (2 & r2.wrap && 35615 === u2) {
                  E[r2.check = 0] = 255 & u2, E[1] = u2 >>> 8 & 255, r2.check = B(r2.check, E, 2, 0), l2 = u2 = 0, r2.mode = 2;
                  break;
                }
                if (r2.flags = 0, r2.head && (r2.head.done = false), !(1 & r2.wrap) || (((255 & u2) << 8) + (u2 >> 8)) % 31) {
                  e2.msg = "incorrect header check", r2.mode = 30;
                  break;
                }
                if (8 != (15 & u2)) {
                  e2.msg = "unknown compression method", r2.mode = 30;
                  break;
                }
                if (l2 -= 4, k = 8 + (15 & (u2 >>>= 4)), 0 === r2.wbits) r2.wbits = k;
                else if (k > r2.wbits) {
                  e2.msg = "invalid window size", r2.mode = 30;
                  break;
                }
                r2.dmax = 1 << k, e2.adler = r2.check = 1, r2.mode = 512 & u2 ? 10 : 12, l2 = u2 = 0;
                break;
              case 2:
                for (; l2 < 16; ) {
                  if (0 === o2) break e;
                  o2--, u2 += n2[s2++] << l2, l2 += 8;
                }
                if (r2.flags = u2, 8 != (255 & r2.flags)) {
                  e2.msg = "unknown compression method", r2.mode = 30;
                  break;
                }
                if (57344 & r2.flags) {
                  e2.msg = "unknown header flags set", r2.mode = 30;
                  break;
                }
                r2.head && (r2.head.text = u2 >> 8 & 1), 512 & r2.flags && (E[0] = 255 & u2, E[1] = u2 >>> 8 & 255, r2.check = B(r2.check, E, 2, 0)), l2 = u2 = 0, r2.mode = 3;
              case 3:
                for (; l2 < 32; ) {
                  if (0 === o2) break e;
                  o2--, u2 += n2[s2++] << l2, l2 += 8;
                }
                r2.head && (r2.head.time = u2), 512 & r2.flags && (E[0] = 255 & u2, E[1] = u2 >>> 8 & 255, E[2] = u2 >>> 16 & 255, E[3] = u2 >>> 24 & 255, r2.check = B(r2.check, E, 4, 0)), l2 = u2 = 0, r2.mode = 4;
              case 4:
                for (; l2 < 16; ) {
                  if (0 === o2) break e;
                  o2--, u2 += n2[s2++] << l2, l2 += 8;
                }
                r2.head && (r2.head.xflags = 255 & u2, r2.head.os = u2 >> 8), 512 & r2.flags && (E[0] = 255 & u2, E[1] = u2 >>> 8 & 255, r2.check = B(r2.check, E, 2, 0)), l2 = u2 = 0, r2.mode = 5;
              case 5:
                if (1024 & r2.flags) {
                  for (; l2 < 16; ) {
                    if (0 === o2) break e;
                    o2--, u2 += n2[s2++] << l2, l2 += 8;
                  }
                  r2.length = u2, r2.head && (r2.head.extra_len = u2), 512 & r2.flags && (E[0] = 255 & u2, E[1] = u2 >>> 8 & 255, r2.check = B(r2.check, E, 2, 0)), l2 = u2 = 0;
                } else r2.head && (r2.head.extra = null);
                r2.mode = 6;
              case 6:
                if (1024 & r2.flags && (o2 < (d = r2.length) && (d = o2), d && (r2.head && (k = r2.head.extra_len - r2.length, r2.head.extra || (r2.head.extra = new Array(r2.head.extra_len)), I.arraySet(r2.head.extra, n2, s2, d, k)), 512 & r2.flags && (r2.check = B(r2.check, n2, d, s2)), o2 -= d, s2 += d, r2.length -= d), r2.length)) break e;
                r2.length = 0, r2.mode = 7;
              case 7:
                if (2048 & r2.flags) {
                  if (0 === o2) break e;
                  for (d = 0; k = n2[s2 + d++], r2.head && k && r2.length < 65536 && (r2.head.name += String.fromCharCode(k)), k && d < o2; ) ;
                  if (512 & r2.flags && (r2.check = B(r2.check, n2, d, s2)), o2 -= d, s2 += d, k) break e;
                } else r2.head && (r2.head.name = null);
                r2.length = 0, r2.mode = 8;
              case 8:
                if (4096 & r2.flags) {
                  if (0 === o2) break e;
                  for (d = 0; k = n2[s2 + d++], r2.head && k && r2.length < 65536 && (r2.head.comment += String.fromCharCode(k)), k && d < o2; ) ;
                  if (512 & r2.flags && (r2.check = B(r2.check, n2, d, s2)), o2 -= d, s2 += d, k) break e;
                } else r2.head && (r2.head.comment = null);
                r2.mode = 9;
              case 9:
                if (512 & r2.flags) {
                  for (; l2 < 16; ) {
                    if (0 === o2) break e;
                    o2--, u2 += n2[s2++] << l2, l2 += 8;
                  }
                  if (u2 !== (65535 & r2.check)) {
                    e2.msg = "header crc mismatch", r2.mode = 30;
                    break;
                  }
                  l2 = u2 = 0;
                }
                r2.head && (r2.head.hcrc = r2.flags >> 9 & 1, r2.head.done = true), e2.adler = r2.check = 0, r2.mode = 12;
                break;
              case 10:
                for (; l2 < 32; ) {
                  if (0 === o2) break e;
                  o2--, u2 += n2[s2++] << l2, l2 += 8;
                }
                e2.adler = r2.check = L(u2), l2 = u2 = 0, r2.mode = 11;
              case 11:
                if (0 === r2.havedict) return e2.next_out = a2, e2.avail_out = h2, e2.next_in = s2, e2.avail_in = o2, r2.hold = u2, r2.bits = l2, 2;
                e2.adler = r2.check = 1, r2.mode = 12;
              case 12:
                if (5 === t2 || 6 === t2) break e;
              case 13:
                if (r2.last) {
                  u2 >>>= 7 & l2, l2 -= 7 & l2, r2.mode = 27;
                  break;
                }
                for (; l2 < 3; ) {
                  if (0 === o2) break e;
                  o2--, u2 += n2[s2++] << l2, l2 += 8;
                }
                switch (r2.last = 1 & u2, l2 -= 1, 3 & (u2 >>>= 1)) {
                  case 0:
                    r2.mode = 14;
                    break;
                  case 1:
                    if (j(r2), r2.mode = 20, 6 !== t2) break;
                    u2 >>>= 2, l2 -= 2;
                    break e;
                  case 2:
                    r2.mode = 17;
                    break;
                  case 3:
                    e2.msg = "invalid block type", r2.mode = 30;
                }
                u2 >>>= 2, l2 -= 2;
                break;
              case 14:
                for (u2 >>>= 7 & l2, l2 -= 7 & l2; l2 < 32; ) {
                  if (0 === o2) break e;
                  o2--, u2 += n2[s2++] << l2, l2 += 8;
                }
                if ((65535 & u2) != (u2 >>> 16 ^ 65535)) {
                  e2.msg = "invalid stored block lengths", r2.mode = 30;
                  break;
                }
                if (r2.length = 65535 & u2, l2 = u2 = 0, r2.mode = 15, 6 === t2) break e;
              case 15:
                r2.mode = 16;
              case 16:
                if (d = r2.length) {
                  if (o2 < d && (d = o2), h2 < d && (d = h2), 0 === d) break e;
                  I.arraySet(i2, n2, s2, d, a2), o2 -= d, s2 += d, h2 -= d, a2 += d, r2.length -= d;
                  break;
                }
                r2.mode = 12;
                break;
              case 17:
                for (; l2 < 14; ) {
                  if (0 === o2) break e;
                  o2--, u2 += n2[s2++] << l2, l2 += 8;
                }
                if (r2.nlen = 257 + (31 & u2), u2 >>>= 5, l2 -= 5, r2.ndist = 1 + (31 & u2), u2 >>>= 5, l2 -= 5, r2.ncode = 4 + (15 & u2), u2 >>>= 4, l2 -= 4, 286 < r2.nlen || 30 < r2.ndist) {
                  e2.msg = "too many length or distance symbols", r2.mode = 30;
                  break;
                }
                r2.have = 0, r2.mode = 18;
              case 18:
                for (; r2.have < r2.ncode; ) {
                  for (; l2 < 3; ) {
                    if (0 === o2) break e;
                    o2--, u2 += n2[s2++] << l2, l2 += 8;
                  }
                  r2.lens[A[r2.have++]] = 7 & u2, u2 >>>= 3, l2 -= 3;
                }
                for (; r2.have < 19; ) r2.lens[A[r2.have++]] = 0;
                if (r2.lencode = r2.lendyn, r2.lenbits = 7, S = { bits: r2.lenbits }, x = T(0, r2.lens, 0, 19, r2.lencode, 0, r2.work, S), r2.lenbits = S.bits, x) {
                  e2.msg = "invalid code lengths set", r2.mode = 30;
                  break;
                }
                r2.have = 0, r2.mode = 19;
              case 19:
                for (; r2.have < r2.nlen + r2.ndist; ) {
                  for (; g = (C = r2.lencode[u2 & (1 << r2.lenbits) - 1]) >>> 16 & 255, b = 65535 & C, !((_ = C >>> 24) <= l2); ) {
                    if (0 === o2) break e;
                    o2--, u2 += n2[s2++] << l2, l2 += 8;
                  }
                  if (b < 16) u2 >>>= _, l2 -= _, r2.lens[r2.have++] = b;
                  else {
                    if (16 === b) {
                      for (z = _ + 2; l2 < z; ) {
                        if (0 === o2) break e;
                        o2--, u2 += n2[s2++] << l2, l2 += 8;
                      }
                      if (u2 >>>= _, l2 -= _, 0 === r2.have) {
                        e2.msg = "invalid bit length repeat", r2.mode = 30;
                        break;
                      }
                      k = r2.lens[r2.have - 1], d = 3 + (3 & u2), u2 >>>= 2, l2 -= 2;
                    } else if (17 === b) {
                      for (z = _ + 3; l2 < z; ) {
                        if (0 === o2) break e;
                        o2--, u2 += n2[s2++] << l2, l2 += 8;
                      }
                      l2 -= _, k = 0, d = 3 + (7 & (u2 >>>= _)), u2 >>>= 3, l2 -= 3;
                    } else {
                      for (z = _ + 7; l2 < z; ) {
                        if (0 === o2) break e;
                        o2--, u2 += n2[s2++] << l2, l2 += 8;
                      }
                      l2 -= _, k = 0, d = 11 + (127 & (u2 >>>= _)), u2 >>>= 7, l2 -= 7;
                    }
                    if (r2.have + d > r2.nlen + r2.ndist) {
                      e2.msg = "invalid bit length repeat", r2.mode = 30;
                      break;
                    }
                    for (; d--; ) r2.lens[r2.have++] = k;
                  }
                }
                if (30 === r2.mode) break;
                if (0 === r2.lens[256]) {
                  e2.msg = "invalid code -- missing end-of-block", r2.mode = 30;
                  break;
                }
                if (r2.lenbits = 9, S = { bits: r2.lenbits }, x = T(D, r2.lens, 0, r2.nlen, r2.lencode, 0, r2.work, S), r2.lenbits = S.bits, x) {
                  e2.msg = "invalid literal/lengths set", r2.mode = 30;
                  break;
                }
                if (r2.distbits = 6, r2.distcode = r2.distdyn, S = { bits: r2.distbits }, x = T(F, r2.lens, r2.nlen, r2.ndist, r2.distcode, 0, r2.work, S), r2.distbits = S.bits, x) {
                  e2.msg = "invalid distances set", r2.mode = 30;
                  break;
                }
                if (r2.mode = 20, 6 === t2) break e;
              case 20:
                r2.mode = 21;
              case 21:
                if (6 <= o2 && 258 <= h2) {
                  e2.next_out = a2, e2.avail_out = h2, e2.next_in = s2, e2.avail_in = o2, r2.hold = u2, r2.bits = l2, R(e2, c2), a2 = e2.next_out, i2 = e2.output, h2 = e2.avail_out, s2 = e2.next_in, n2 = e2.input, o2 = e2.avail_in, u2 = r2.hold, l2 = r2.bits, 12 === r2.mode && (r2.back = -1);
                  break;
                }
                for (r2.back = 0; g = (C = r2.lencode[u2 & (1 << r2.lenbits) - 1]) >>> 16 & 255, b = 65535 & C, !((_ = C >>> 24) <= l2); ) {
                  if (0 === o2) break e;
                  o2--, u2 += n2[s2++] << l2, l2 += 8;
                }
                if (g && 0 == (240 & g)) {
                  for (v = _, y = g, w = b; g = (C = r2.lencode[w + ((u2 & (1 << v + y) - 1) >> v)]) >>> 16 & 255, b = 65535 & C, !(v + (_ = C >>> 24) <= l2); ) {
                    if (0 === o2) break e;
                    o2--, u2 += n2[s2++] << l2, l2 += 8;
                  }
                  u2 >>>= v, l2 -= v, r2.back += v;
                }
                if (u2 >>>= _, l2 -= _, r2.back += _, r2.length = b, 0 === g) {
                  r2.mode = 26;
                  break;
                }
                if (32 & g) {
                  r2.back = -1, r2.mode = 12;
                  break;
                }
                if (64 & g) {
                  e2.msg = "invalid literal/length code", r2.mode = 30;
                  break;
                }
                r2.extra = 15 & g, r2.mode = 22;
              case 22:
                if (r2.extra) {
                  for (z = r2.extra; l2 < z; ) {
                    if (0 === o2) break e;
                    o2--, u2 += n2[s2++] << l2, l2 += 8;
                  }
                  r2.length += u2 & (1 << r2.extra) - 1, u2 >>>= r2.extra, l2 -= r2.extra, r2.back += r2.extra;
                }
                r2.was = r2.length, r2.mode = 23;
              case 23:
                for (; g = (C = r2.distcode[u2 & (1 << r2.distbits) - 1]) >>> 16 & 255, b = 65535 & C, !((_ = C >>> 24) <= l2); ) {
                  if (0 === o2) break e;
                  o2--, u2 += n2[s2++] << l2, l2 += 8;
                }
                if (0 == (240 & g)) {
                  for (v = _, y = g, w = b; g = (C = r2.distcode[w + ((u2 & (1 << v + y) - 1) >> v)]) >>> 16 & 255, b = 65535 & C, !(v + (_ = C >>> 24) <= l2); ) {
                    if (0 === o2) break e;
                    o2--, u2 += n2[s2++] << l2, l2 += 8;
                  }
                  u2 >>>= v, l2 -= v, r2.back += v;
                }
                if (u2 >>>= _, l2 -= _, r2.back += _, 64 & g) {
                  e2.msg = "invalid distance code", r2.mode = 30;
                  break;
                }
                r2.offset = b, r2.extra = 15 & g, r2.mode = 24;
              case 24:
                if (r2.extra) {
                  for (z = r2.extra; l2 < z; ) {
                    if (0 === o2) break e;
                    o2--, u2 += n2[s2++] << l2, l2 += 8;
                  }
                  r2.offset += u2 & (1 << r2.extra) - 1, u2 >>>= r2.extra, l2 -= r2.extra, r2.back += r2.extra;
                }
                if (r2.offset > r2.dmax) {
                  e2.msg = "invalid distance too far back", r2.mode = 30;
                  break;
                }
                r2.mode = 25;
              case 25:
                if (0 === h2) break e;
                if (d = c2 - h2, r2.offset > d) {
                  if ((d = r2.offset - d) > r2.whave && r2.sane) {
                    e2.msg = "invalid distance too far back", r2.mode = 30;
                    break;
                  }
                  p = d > r2.wnext ? (d -= r2.wnext, r2.wsize - d) : r2.wnext - d, d > r2.length && (d = r2.length), m = r2.window;
                } else m = i2, p = a2 - r2.offset, d = r2.length;
                for (h2 < d && (d = h2), h2 -= d, r2.length -= d; i2[a2++] = m[p++], --d; ) ;
                0 === r2.length && (r2.mode = 21);
                break;
              case 26:
                if (0 === h2) break e;
                i2[a2++] = r2.length, h2--, r2.mode = 21;
                break;
              case 27:
                if (r2.wrap) {
                  for (; l2 < 32; ) {
                    if (0 === o2) break e;
                    o2--, u2 |= n2[s2++] << l2, l2 += 8;
                  }
                  if (c2 -= h2, e2.total_out += c2, r2.total += c2, c2 && (e2.adler = r2.check = r2.flags ? B(r2.check, i2, c2, a2 - c2) : O(r2.check, i2, c2, a2 - c2)), c2 = h2, (r2.flags ? u2 : L(u2)) !== r2.check) {
                    e2.msg = "incorrect data check", r2.mode = 30;
                    break;
                  }
                  l2 = u2 = 0;
                }
                r2.mode = 28;
              case 28:
                if (r2.wrap && r2.flags) {
                  for (; l2 < 32; ) {
                    if (0 === o2) break e;
                    o2--, u2 += n2[s2++] << l2, l2 += 8;
                  }
                  if (u2 !== (4294967295 & r2.total)) {
                    e2.msg = "incorrect length check", r2.mode = 30;
                    break;
                  }
                  l2 = u2 = 0;
                }
                r2.mode = 29;
              case 29:
                x = 1;
                break e;
              case 30:
                x = -3;
                break e;
              case 31:
                return -4;
              case 32:
              default:
                return U;
            }
            return e2.next_out = a2, e2.avail_out = h2, e2.next_in = s2, e2.avail_in = o2, r2.hold = u2, r2.bits = l2, (r2.wsize || c2 !== e2.avail_out && r2.mode < 30 && (r2.mode < 27 || 4 !== t2)) && Z(e2, e2.output, e2.next_out, c2 - e2.avail_out) ? (r2.mode = 31, -4) : (f2 -= e2.avail_in, c2 -= e2.avail_out, e2.total_in += f2, e2.total_out += c2, r2.total += c2, r2.wrap && c2 && (e2.adler = r2.check = r2.flags ? B(r2.check, i2, c2, e2.next_out - c2) : O(r2.check, i2, c2, e2.next_out - c2)), e2.data_type = r2.bits + (r2.last ? 64 : 0) + (12 === r2.mode ? 128 : 0) + (20 === r2.mode || 15 === r2.mode ? 256 : 0), (0 == f2 && 0 === c2 || 4 === t2) && x === N && (x = -5), x);
          }, r.inflateEnd = function(e2) {
            if (!e2 || !e2.state) return U;
            var t2 = e2.state;
            return t2.window && (t2.window = null), e2.state = null, N;
          }, r.inflateGetHeader = function(e2, t2) {
            var r2;
            return e2 && e2.state ? 0 == (2 & (r2 = e2.state).wrap) ? U : ((r2.head = t2).done = false, N) : U;
          }, r.inflateSetDictionary = function(e2, t2) {
            var r2, n2 = t2.length;
            return e2 && e2.state ? 0 !== (r2 = e2.state).wrap && 11 !== r2.mode ? U : 11 === r2.mode && O(1, t2, n2, 0) !== r2.check ? -3 : Z(e2, t2, n2, n2) ? (r2.mode = 31, -4) : (r2.havedict = 1, N) : U;
          }, r.inflateInfo = "pako inflate (from Nodeca project)";
        }, { "../utils/common": 41, "./adler32": 43, "./crc32": 45, "./inffast": 48, "./inftrees": 50 }], 50: [function(e, t, r) {
          "use strict";
          var D = e("../utils/common"), F = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258, 0, 0], N = [16, 16, 16, 16, 16, 16, 16, 16, 17, 17, 17, 17, 18, 18, 18, 18, 19, 19, 19, 19, 20, 20, 20, 20, 21, 21, 21, 21, 16, 72, 78], U = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577, 0, 0], P = [16, 16, 16, 16, 17, 17, 18, 18, 19, 19, 20, 20, 21, 21, 22, 22, 23, 23, 24, 24, 25, 25, 26, 26, 27, 27, 28, 28, 29, 29, 64, 64];
          t.exports = function(e2, t2, r2, n, i, s, a, o) {
            var h, u, l, f, c, d, p, m, _, g = o.bits, b = 0, v = 0, y = 0, w = 0, k = 0, x = 0, S = 0, z = 0, C = 0, E = 0, A = null, I = 0, O = new D.Buf16(16), B = new D.Buf16(16), R = null, T = 0;
            for (b = 0; b <= 15; b++) O[b] = 0;
            for (v = 0; v < n; v++) O[t2[r2 + v]]++;
            for (k = g, w = 15; 1 <= w && 0 === O[w]; w--) ;
            if (w < k && (k = w), 0 === w) return i[s++] = 20971520, i[s++] = 20971520, o.bits = 1, 0;
            for (y = 1; y < w && 0 === O[y]; y++) ;
            for (k < y && (k = y), b = z = 1; b <= 15; b++) if (z <<= 1, (z -= O[b]) < 0) return -1;
            if (0 < z && (0 === e2 || 1 !== w)) return -1;
            for (B[1] = 0, b = 1; b < 15; b++) B[b + 1] = B[b] + O[b];
            for (v = 0; v < n; v++) 0 !== t2[r2 + v] && (a[B[t2[r2 + v]]++] = v);
            if (d = 0 === e2 ? (A = R = a, 19) : 1 === e2 ? (A = F, I -= 257, R = N, T -= 257, 256) : (A = U, R = P, -1), b = y, c = s, S = v = E = 0, l = -1, f = (C = 1 << (x = k)) - 1, 1 === e2 && 852 < C || 2 === e2 && 592 < C) return 1;
            for (; ; ) {
              for (p = b - S, _ = a[v] < d ? (m = 0, a[v]) : a[v] > d ? (m = R[T + a[v]], A[I + a[v]]) : (m = 96, 0), h = 1 << b - S, y = u = 1 << x; i[c + (E >> S) + (u -= h)] = p << 24 | m << 16 | _ | 0, 0 !== u; ) ;
              for (h = 1 << b - 1; E & h; ) h >>= 1;
              if (0 !== h ? (E &= h - 1, E += h) : E = 0, v++, 0 == --O[b]) {
                if (b === w) break;
                b = t2[r2 + a[v]];
              }
              if (k < b && (E & f) !== l) {
                for (0 === S && (S = k), c += y, z = 1 << (x = b - S); x + S < w && !((z -= O[x + S]) <= 0); ) x++, z <<= 1;
                if (C += 1 << x, 1 === e2 && 852 < C || 2 === e2 && 592 < C) return 1;
                i[l = E & f] = k << 24 | x << 16 | c - s | 0;
              }
            }
            return 0 !== E && (i[c + E] = b - S << 24 | 64 << 16 | 0), o.bits = k, 0;
          };
        }, { "../utils/common": 41 }], 51: [function(e, t, r) {
          "use strict";
          t.exports = { 2: "need dictionary", 1: "stream end", 0: "", "-1": "file error", "-2": "stream error", "-3": "data error", "-4": "insufficient memory", "-5": "buffer error", "-6": "incompatible version" };
        }, {}], 52: [function(e, t, r) {
          "use strict";
          var i = e("../utils/common"), o = 0, h = 1;
          function n(e2) {
            for (var t2 = e2.length; 0 <= --t2; ) e2[t2] = 0;
          }
          var s = 0, a = 29, u = 256, l = u + 1 + a, f = 30, c = 19, _ = 2 * l + 1, g = 15, d = 16, p = 7, m = 256, b = 16, v = 17, y = 18, w = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0], k = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13], x = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7], S = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15], z = new Array(2 * (l + 2));
          n(z);
          var C = new Array(2 * f);
          n(C);
          var E = new Array(512);
          n(E);
          var A = new Array(256);
          n(A);
          var I = new Array(a);
          n(I);
          var O, B, R, T = new Array(f);
          function D(e2, t2, r2, n2, i2) {
            this.static_tree = e2, this.extra_bits = t2, this.extra_base = r2, this.elems = n2, this.max_length = i2, this.has_stree = e2 && e2.length;
          }
          function F(e2, t2) {
            this.dyn_tree = e2, this.max_code = 0, this.stat_desc = t2;
          }
          function N(e2) {
            return e2 < 256 ? E[e2] : E[256 + (e2 >>> 7)];
          }
          function U(e2, t2) {
            e2.pending_buf[e2.pending++] = 255 & t2, e2.pending_buf[e2.pending++] = t2 >>> 8 & 255;
          }
          function P(e2, t2, r2) {
            e2.bi_valid > d - r2 ? (e2.bi_buf |= t2 << e2.bi_valid & 65535, U(e2, e2.bi_buf), e2.bi_buf = t2 >> d - e2.bi_valid, e2.bi_valid += r2 - d) : (e2.bi_buf |= t2 << e2.bi_valid & 65535, e2.bi_valid += r2);
          }
          function L(e2, t2, r2) {
            P(e2, r2[2 * t2], r2[2 * t2 + 1]);
          }
          function j(e2, t2) {
            for (var r2 = 0; r2 |= 1 & e2, e2 >>>= 1, r2 <<= 1, 0 < --t2; ) ;
            return r2 >>> 1;
          }
          function Z(e2, t2, r2) {
            var n2, i2, s2 = new Array(g + 1), a2 = 0;
            for (n2 = 1; n2 <= g; n2++) s2[n2] = a2 = a2 + r2[n2 - 1] << 1;
            for (i2 = 0; i2 <= t2; i2++) {
              var o2 = e2[2 * i2 + 1];
              0 !== o2 && (e2[2 * i2] = j(s2[o2]++, o2));
            }
          }
          function W(e2) {
            var t2;
            for (t2 = 0; t2 < l; t2++) e2.dyn_ltree[2 * t2] = 0;
            for (t2 = 0; t2 < f; t2++) e2.dyn_dtree[2 * t2] = 0;
            for (t2 = 0; t2 < c; t2++) e2.bl_tree[2 * t2] = 0;
            e2.dyn_ltree[2 * m] = 1, e2.opt_len = e2.static_len = 0, e2.last_lit = e2.matches = 0;
          }
          function M(e2) {
            8 < e2.bi_valid ? U(e2, e2.bi_buf) : 0 < e2.bi_valid && (e2.pending_buf[e2.pending++] = e2.bi_buf), e2.bi_buf = 0, e2.bi_valid = 0;
          }
          function H(e2, t2, r2, n2) {
            var i2 = 2 * t2, s2 = 2 * r2;
            return e2[i2] < e2[s2] || e2[i2] === e2[s2] && n2[t2] <= n2[r2];
          }
          function G(e2, t2, r2) {
            for (var n2 = e2.heap[r2], i2 = r2 << 1; i2 <= e2.heap_len && (i2 < e2.heap_len && H(t2, e2.heap[i2 + 1], e2.heap[i2], e2.depth) && i2++, !H(t2, n2, e2.heap[i2], e2.depth)); ) e2.heap[r2] = e2.heap[i2], r2 = i2, i2 <<= 1;
            e2.heap[r2] = n2;
          }
          function K(e2, t2, r2) {
            var n2, i2, s2, a2, o2 = 0;
            if (0 !== e2.last_lit) for (; n2 = e2.pending_buf[e2.d_buf + 2 * o2] << 8 | e2.pending_buf[e2.d_buf + 2 * o2 + 1], i2 = e2.pending_buf[e2.l_buf + o2], o2++, 0 === n2 ? L(e2, i2, t2) : (L(e2, (s2 = A[i2]) + u + 1, t2), 0 !== (a2 = w[s2]) && P(e2, i2 -= I[s2], a2), L(e2, s2 = N(--n2), r2), 0 !== (a2 = k[s2]) && P(e2, n2 -= T[s2], a2)), o2 < e2.last_lit; ) ;
            L(e2, m, t2);
          }
          function Y(e2, t2) {
            var r2, n2, i2, s2 = t2.dyn_tree, a2 = t2.stat_desc.static_tree, o2 = t2.stat_desc.has_stree, h2 = t2.stat_desc.elems, u2 = -1;
            for (e2.heap_len = 0, e2.heap_max = _, r2 = 0; r2 < h2; r2++) 0 !== s2[2 * r2] ? (e2.heap[++e2.heap_len] = u2 = r2, e2.depth[r2] = 0) : s2[2 * r2 + 1] = 0;
            for (; e2.heap_len < 2; ) s2[2 * (i2 = e2.heap[++e2.heap_len] = u2 < 2 ? ++u2 : 0)] = 1, e2.depth[i2] = 0, e2.opt_len--, o2 && (e2.static_len -= a2[2 * i2 + 1]);
            for (t2.max_code = u2, r2 = e2.heap_len >> 1; 1 <= r2; r2--) G(e2, s2, r2);
            for (i2 = h2; r2 = e2.heap[1], e2.heap[1] = e2.heap[e2.heap_len--], G(e2, s2, 1), n2 = e2.heap[1], e2.heap[--e2.heap_max] = r2, e2.heap[--e2.heap_max] = n2, s2[2 * i2] = s2[2 * r2] + s2[2 * n2], e2.depth[i2] = (e2.depth[r2] >= e2.depth[n2] ? e2.depth[r2] : e2.depth[n2]) + 1, s2[2 * r2 + 1] = s2[2 * n2 + 1] = i2, e2.heap[1] = i2++, G(e2, s2, 1), 2 <= e2.heap_len; ) ;
            e2.heap[--e2.heap_max] = e2.heap[1], (function(e3, t3) {
              var r3, n3, i3, s3, a3, o3, h3 = t3.dyn_tree, u3 = t3.max_code, l2 = t3.stat_desc.static_tree, f2 = t3.stat_desc.has_stree, c2 = t3.stat_desc.extra_bits, d2 = t3.stat_desc.extra_base, p2 = t3.stat_desc.max_length, m2 = 0;
              for (s3 = 0; s3 <= g; s3++) e3.bl_count[s3] = 0;
              for (h3[2 * e3.heap[e3.heap_max] + 1] = 0, r3 = e3.heap_max + 1; r3 < _; r3++) p2 < (s3 = h3[2 * h3[2 * (n3 = e3.heap[r3]) + 1] + 1] + 1) && (s3 = p2, m2++), h3[2 * n3 + 1] = s3, u3 < n3 || (e3.bl_count[s3]++, a3 = 0, d2 <= n3 && (a3 = c2[n3 - d2]), o3 = h3[2 * n3], e3.opt_len += o3 * (s3 + a3), f2 && (e3.static_len += o3 * (l2[2 * n3 + 1] + a3)));
              if (0 !== m2) {
                do {
                  for (s3 = p2 - 1; 0 === e3.bl_count[s3]; ) s3--;
                  e3.bl_count[s3]--, e3.bl_count[s3 + 1] += 2, e3.bl_count[p2]--, m2 -= 2;
                } while (0 < m2);
                for (s3 = p2; 0 !== s3; s3--) for (n3 = e3.bl_count[s3]; 0 !== n3; ) u3 < (i3 = e3.heap[--r3]) || (h3[2 * i3 + 1] !== s3 && (e3.opt_len += (s3 - h3[2 * i3 + 1]) * h3[2 * i3], h3[2 * i3 + 1] = s3), n3--);
              }
            })(e2, t2), Z(s2, u2, e2.bl_count);
          }
          function X(e2, t2, r2) {
            var n2, i2, s2 = -1, a2 = t2[1], o2 = 0, h2 = 7, u2 = 4;
            for (0 === a2 && (h2 = 138, u2 = 3), t2[2 * (r2 + 1) + 1] = 65535, n2 = 0; n2 <= r2; n2++) i2 = a2, a2 = t2[2 * (n2 + 1) + 1], ++o2 < h2 && i2 === a2 || (o2 < u2 ? e2.bl_tree[2 * i2] += o2 : 0 !== i2 ? (i2 !== s2 && e2.bl_tree[2 * i2]++, e2.bl_tree[2 * b]++) : o2 <= 10 ? e2.bl_tree[2 * v]++ : e2.bl_tree[2 * y]++, s2 = i2, u2 = (o2 = 0) === a2 ? (h2 = 138, 3) : i2 === a2 ? (h2 = 6, 3) : (h2 = 7, 4));
          }
          function V(e2, t2, r2) {
            var n2, i2, s2 = -1, a2 = t2[1], o2 = 0, h2 = 7, u2 = 4;
            for (0 === a2 && (h2 = 138, u2 = 3), n2 = 0; n2 <= r2; n2++) if (i2 = a2, a2 = t2[2 * (n2 + 1) + 1], !(++o2 < h2 && i2 === a2)) {
              if (o2 < u2) for (; L(e2, i2, e2.bl_tree), 0 != --o2; ) ;
              else 0 !== i2 ? (i2 !== s2 && (L(e2, i2, e2.bl_tree), o2--), L(e2, b, e2.bl_tree), P(e2, o2 - 3, 2)) : o2 <= 10 ? (L(e2, v, e2.bl_tree), P(e2, o2 - 3, 3)) : (L(e2, y, e2.bl_tree), P(e2, o2 - 11, 7));
              s2 = i2, u2 = (o2 = 0) === a2 ? (h2 = 138, 3) : i2 === a2 ? (h2 = 6, 3) : (h2 = 7, 4);
            }
          }
          n(T);
          var q = false;
          function J(e2, t2, r2, n2) {
            P(e2, (s << 1) + (n2 ? 1 : 0), 3), (function(e3, t3, r3, n3) {
              M(e3), n3 && (U(e3, r3), U(e3, ~r3)), i.arraySet(e3.pending_buf, e3.window, t3, r3, e3.pending), e3.pending += r3;
            })(e2, t2, r2, true);
          }
          r._tr_init = function(e2) {
            q || ((function() {
              var e3, t2, r2, n2, i2, s2 = new Array(g + 1);
              for (n2 = r2 = 0; n2 < a - 1; n2++) for (I[n2] = r2, e3 = 0; e3 < 1 << w[n2]; e3++) A[r2++] = n2;
              for (A[r2 - 1] = n2, n2 = i2 = 0; n2 < 16; n2++) for (T[n2] = i2, e3 = 0; e3 < 1 << k[n2]; e3++) E[i2++] = n2;
              for (i2 >>= 7; n2 < f; n2++) for (T[n2] = i2 << 7, e3 = 0; e3 < 1 << k[n2] - 7; e3++) E[256 + i2++] = n2;
              for (t2 = 0; t2 <= g; t2++) s2[t2] = 0;
              for (e3 = 0; e3 <= 143; ) z[2 * e3 + 1] = 8, e3++, s2[8]++;
              for (; e3 <= 255; ) z[2 * e3 + 1] = 9, e3++, s2[9]++;
              for (; e3 <= 279; ) z[2 * e3 + 1] = 7, e3++, s2[7]++;
              for (; e3 <= 287; ) z[2 * e3 + 1] = 8, e3++, s2[8]++;
              for (Z(z, l + 1, s2), e3 = 0; e3 < f; e3++) C[2 * e3 + 1] = 5, C[2 * e3] = j(e3, 5);
              O = new D(z, w, u + 1, l, g), B = new D(C, k, 0, f, g), R = new D(new Array(0), x, 0, c, p);
            })(), q = true), e2.l_desc = new F(e2.dyn_ltree, O), e2.d_desc = new F(e2.dyn_dtree, B), e2.bl_desc = new F(e2.bl_tree, R), e2.bi_buf = 0, e2.bi_valid = 0, W(e2);
          }, r._tr_stored_block = J, r._tr_flush_block = function(e2, t2, r2, n2) {
            var i2, s2, a2 = 0;
            0 < e2.level ? (2 === e2.strm.data_type && (e2.strm.data_type = (function(e3) {
              var t3, r3 = 4093624447;
              for (t3 = 0; t3 <= 31; t3++, r3 >>>= 1) if (1 & r3 && 0 !== e3.dyn_ltree[2 * t3]) return o;
              if (0 !== e3.dyn_ltree[18] || 0 !== e3.dyn_ltree[20] || 0 !== e3.dyn_ltree[26]) return h;
              for (t3 = 32; t3 < u; t3++) if (0 !== e3.dyn_ltree[2 * t3]) return h;
              return o;
            })(e2)), Y(e2, e2.l_desc), Y(e2, e2.d_desc), a2 = (function(e3) {
              var t3;
              for (X(e3, e3.dyn_ltree, e3.l_desc.max_code), X(e3, e3.dyn_dtree, e3.d_desc.max_code), Y(e3, e3.bl_desc), t3 = c - 1; 3 <= t3 && 0 === e3.bl_tree[2 * S[t3] + 1]; t3--) ;
              return e3.opt_len += 3 * (t3 + 1) + 5 + 5 + 4, t3;
            })(e2), i2 = e2.opt_len + 3 + 7 >>> 3, (s2 = e2.static_len + 3 + 7 >>> 3) <= i2 && (i2 = s2)) : i2 = s2 = r2 + 5, r2 + 4 <= i2 && -1 !== t2 ? J(e2, t2, r2, n2) : 4 === e2.strategy || s2 === i2 ? (P(e2, 2 + (n2 ? 1 : 0), 3), K(e2, z, C)) : (P(e2, 4 + (n2 ? 1 : 0), 3), (function(e3, t3, r3, n3) {
              var i3;
              for (P(e3, t3 - 257, 5), P(e3, r3 - 1, 5), P(e3, n3 - 4, 4), i3 = 0; i3 < n3; i3++) P(e3, e3.bl_tree[2 * S[i3] + 1], 3);
              V(e3, e3.dyn_ltree, t3 - 1), V(e3, e3.dyn_dtree, r3 - 1);
            })(e2, e2.l_desc.max_code + 1, e2.d_desc.max_code + 1, a2 + 1), K(e2, e2.dyn_ltree, e2.dyn_dtree)), W(e2), n2 && M(e2);
          }, r._tr_tally = function(e2, t2, r2) {
            return e2.pending_buf[e2.d_buf + 2 * e2.last_lit] = t2 >>> 8 & 255, e2.pending_buf[e2.d_buf + 2 * e2.last_lit + 1] = 255 & t2, e2.pending_buf[e2.l_buf + e2.last_lit] = 255 & r2, e2.last_lit++, 0 === t2 ? e2.dyn_ltree[2 * r2]++ : (e2.matches++, t2--, e2.dyn_ltree[2 * (A[r2] + u + 1)]++, e2.dyn_dtree[2 * N(t2)]++), e2.last_lit === e2.lit_bufsize - 1;
          }, r._tr_align = function(e2) {
            P(e2, 2, 3), L(e2, m, z), (function(e3) {
              16 === e3.bi_valid ? (U(e3, e3.bi_buf), e3.bi_buf = 0, e3.bi_valid = 0) : 8 <= e3.bi_valid && (e3.pending_buf[e3.pending++] = 255 & e3.bi_buf, e3.bi_buf >>= 8, e3.bi_valid -= 8);
            })(e2);
          };
        }, { "../utils/common": 41 }], 53: [function(e, t, r) {
          "use strict";
          t.exports = function() {
            this.input = null, this.next_in = 0, this.avail_in = 0, this.total_in = 0, this.output = null, this.next_out = 0, this.avail_out = 0, this.total_out = 0, this.msg = "", this.state = null, this.data_type = 2, this.adler = 0;
          };
        }, {}], 54: [function(e, t, r) {
          (function(e2) {
            !(function(r2, n) {
              "use strict";
              if (!r2.setImmediate) {
                var i, s, t2, a, o = 1, h = {}, u = false, l = r2.document, e3 = Object.getPrototypeOf && Object.getPrototypeOf(r2);
                e3 = e3 && e3.setTimeout ? e3 : r2, i = "[object process]" === {}.toString.call(r2.process) ? function(e4) {
                  process.nextTick(function() {
                    c(e4);
                  });
                } : (function() {
                  if (r2.postMessage && !r2.importScripts) {
                    var e4 = true, t3 = r2.onmessage;
                    return r2.onmessage = function() {
                      e4 = false;
                    }, r2.postMessage("", "*"), r2.onmessage = t3, e4;
                  }
                })() ? (a = "setImmediate$" + Math.random() + "$", r2.addEventListener ? r2.addEventListener("message", d, false) : r2.attachEvent("onmessage", d), function(e4) {
                  r2.postMessage(a + e4, "*");
                }) : r2.MessageChannel ? ((t2 = new MessageChannel()).port1.onmessage = function(e4) {
                  c(e4.data);
                }, function(e4) {
                  t2.port2.postMessage(e4);
                }) : l && "onreadystatechange" in l.createElement("script") ? (s = l.documentElement, function(e4) {
                  var t3 = l.createElement("script");
                  t3.onreadystatechange = function() {
                    c(e4), t3.onreadystatechange = null, s.removeChild(t3), t3 = null;
                  }, s.appendChild(t3);
                }) : function(e4) {
                  setTimeout(c, 0, e4);
                }, e3.setImmediate = function(e4) {
                  "function" != typeof e4 && (e4 = new Function("" + e4));
                  for (var t3 = new Array(arguments.length - 1), r3 = 0; r3 < t3.length; r3++) t3[r3] = arguments[r3 + 1];
                  var n2 = { callback: e4, args: t3 };
                  return h[o] = n2, i(o), o++;
                }, e3.clearImmediate = f;
              }
              function f(e4) {
                delete h[e4];
              }
              function c(e4) {
                if (u) setTimeout(c, 0, e4);
                else {
                  var t3 = h[e4];
                  if (t3) {
                    u = true;
                    try {
                      !(function(e5) {
                        var t4 = e5.callback, r3 = e5.args;
                        switch (r3.length) {
                          case 0:
                            t4();
                            break;
                          case 1:
                            t4(r3[0]);
                            break;
                          case 2:
                            t4(r3[0], r3[1]);
                            break;
                          case 3:
                            t4(r3[0], r3[1], r3[2]);
                            break;
                          default:
                            t4.apply(n, r3);
                        }
                      })(t3);
                    } finally {
                      f(e4), u = false;
                    }
                  }
                }
              }
              function d(e4) {
                e4.source === r2 && "string" == typeof e4.data && 0 === e4.data.indexOf(a) && c(+e4.data.slice(a.length));
              }
            })("undefined" == typeof self ? void 0 === e2 ? this : e2 : self);
          }).call(this, "undefined" != typeof global ? global : "undefined" != typeof self ? self : "undefined" != typeof window ? window : {});
        }, {}] }, {}, [10])(10);
      });
    }
  });

  // src/bridge.ts
  var commandTypes = ["runtime.initialize", "model.load", "model.unload", "model.setView", "model.setFocus", "model.hitTest", "motion.play", "expression.set", "expression.clear", "speech.setMouth", "speech.setSpeaking", "runtime.pause", "runtime.resume", "runtime.setFPS", "runtime.queryCapabilities"];
  var object = (x) => !!x && typeof x === "object" && !Array.isArray(x);
  function decodeCommand(raw) {
    if (!object(raw) || raw.version !== 1 || typeof raw.id !== "string" || raw.id.length > 128 || !raw.id || !commandTypes.includes(raw.type) || !object(raw.payload)) throw new Error("Invalid v1 command envelope");
    const p = raw.payload, t = raw.type;
    const number = (k, min, max) => typeof p[k] === "number" && Number.isFinite(p[k]) && p[k] >= min && p[k] <= max;
    const string = (k) => typeof p[k] === "string" && p[k].length > 0 && p[k].length <= 512;
    let valid = true;
    let keys = [];
    switch (t) {
      case "runtime.initialize":
        keys = ["preserveDrawingBuffer"];
        valid = p.preserveDrawingBuffer === void 0 || typeof p.preserveDrawingBuffer === "boolean";
        break;
      case "model.load":
        keys = ["source", "appearanceExpressions"];
        valid = string("source") && /^deskpet:\/\/models\//.test(p.source) && (p.appearanceExpressions === void 0 || Array.isArray(p.appearanceExpressions) && p.appearanceExpressions.length <= 16 && new Set(p.appearanceExpressions).size === p.appearanceExpressions.length && p.appearanceExpressions.every((x) => typeof x === "string" && x.length > 0 && x.length <= 512));
        break;
      case "model.setView":
        keys = ["scale", "x", "y"];
        valid = number("scale", 0.05, 10) && number("x", -1e4, 1e4) && number("y", -1e4, 1e4);
        break;
      case "model.setFocus":
        keys = ["x", "y", "active"];
        valid = number("x", -1, 1) && number("y", -1, 1) && typeof p.active === "boolean";
        break;
      case "model.hitTest":
        keys = ["x", "y"];
        valid = number("x", 0, 1e4) && number("y", 0, 1e4);
        break;
      case "motion.play":
        keys = ["group", "index"];
        valid = string("group") && number("index", 0, 1e4) && Number.isInteger(p.index);
        break;
      case "expression.set":
        keys = ["name"];
        valid = string("name");
        break;
      case "speech.setMouth":
        keys = ["openness"];
        valid = number("openness", 0, 1);
        break;
      case "speech.setSpeaking":
        keys = ["speaking"];
        valid = typeof p.speaking === "boolean";
        break;
      case "runtime.setFPS":
        keys = ["fps"];
        valid = number("fps", 1, 60);
        break;
    }
    if (!valid || Object.keys(p).some((k) => !keys.includes(k))) throw new Error("Invalid payload for " + t);
    return raw;
  }
  function emit(type, payload = {}, id) {
    const message = { version: 1, type, payload, ...id ? { id } : {} };
    const host = window.webkit?.messageHandlers?.live2d;
    if (host) host.postMessage(message);
  }
  function commandFailureIsFatal(type) {
    return type === "model.load" || type === "runtime.initialize";
  }

  // node_modules/@pixi/constants/dist/esm/constants.mjs
  var ENV;
  (function(ENV2) {
    ENV2[ENV2["WEBGL_LEGACY"] = 0] = "WEBGL_LEGACY";
    ENV2[ENV2["WEBGL"] = 1] = "WEBGL";
    ENV2[ENV2["WEBGL2"] = 2] = "WEBGL2";
  })(ENV || (ENV = {}));
  var RENDERER_TYPE;
  (function(RENDERER_TYPE2) {
    RENDERER_TYPE2[RENDERER_TYPE2["UNKNOWN"] = 0] = "UNKNOWN";
    RENDERER_TYPE2[RENDERER_TYPE2["WEBGL"] = 1] = "WEBGL";
    RENDERER_TYPE2[RENDERER_TYPE2["CANVAS"] = 2] = "CANVAS";
  })(RENDERER_TYPE || (RENDERER_TYPE = {}));
  var BUFFER_BITS;
  (function(BUFFER_BITS2) {
    BUFFER_BITS2[BUFFER_BITS2["COLOR"] = 16384] = "COLOR";
    BUFFER_BITS2[BUFFER_BITS2["DEPTH"] = 256] = "DEPTH";
    BUFFER_BITS2[BUFFER_BITS2["STENCIL"] = 1024] = "STENCIL";
  })(BUFFER_BITS || (BUFFER_BITS = {}));
  var BLEND_MODES;
  (function(BLEND_MODES2) {
    BLEND_MODES2[BLEND_MODES2["NORMAL"] = 0] = "NORMAL";
    BLEND_MODES2[BLEND_MODES2["ADD"] = 1] = "ADD";
    BLEND_MODES2[BLEND_MODES2["MULTIPLY"] = 2] = "MULTIPLY";
    BLEND_MODES2[BLEND_MODES2["SCREEN"] = 3] = "SCREEN";
    BLEND_MODES2[BLEND_MODES2["OVERLAY"] = 4] = "OVERLAY";
    BLEND_MODES2[BLEND_MODES2["DARKEN"] = 5] = "DARKEN";
    BLEND_MODES2[BLEND_MODES2["LIGHTEN"] = 6] = "LIGHTEN";
    BLEND_MODES2[BLEND_MODES2["COLOR_DODGE"] = 7] = "COLOR_DODGE";
    BLEND_MODES2[BLEND_MODES2["COLOR_BURN"] = 8] = "COLOR_BURN";
    BLEND_MODES2[BLEND_MODES2["HARD_LIGHT"] = 9] = "HARD_LIGHT";
    BLEND_MODES2[BLEND_MODES2["SOFT_LIGHT"] = 10] = "SOFT_LIGHT";
    BLEND_MODES2[BLEND_MODES2["DIFFERENCE"] = 11] = "DIFFERENCE";
    BLEND_MODES2[BLEND_MODES2["EXCLUSION"] = 12] = "EXCLUSION";
    BLEND_MODES2[BLEND_MODES2["HUE"] = 13] = "HUE";
    BLEND_MODES2[BLEND_MODES2["SATURATION"] = 14] = "SATURATION";
    BLEND_MODES2[BLEND_MODES2["COLOR"] = 15] = "COLOR";
    BLEND_MODES2[BLEND_MODES2["LUMINOSITY"] = 16] = "LUMINOSITY";
    BLEND_MODES2[BLEND_MODES2["NORMAL_NPM"] = 17] = "NORMAL_NPM";
    BLEND_MODES2[BLEND_MODES2["ADD_NPM"] = 18] = "ADD_NPM";
    BLEND_MODES2[BLEND_MODES2["SCREEN_NPM"] = 19] = "SCREEN_NPM";
    BLEND_MODES2[BLEND_MODES2["NONE"] = 20] = "NONE";
    BLEND_MODES2[BLEND_MODES2["SRC_OVER"] = 0] = "SRC_OVER";
    BLEND_MODES2[BLEND_MODES2["SRC_IN"] = 21] = "SRC_IN";
    BLEND_MODES2[BLEND_MODES2["SRC_OUT"] = 22] = "SRC_OUT";
    BLEND_MODES2[BLEND_MODES2["SRC_ATOP"] = 23] = "SRC_ATOP";
    BLEND_MODES2[BLEND_MODES2["DST_OVER"] = 24] = "DST_OVER";
    BLEND_MODES2[BLEND_MODES2["DST_IN"] = 25] = "DST_IN";
    BLEND_MODES2[BLEND_MODES2["DST_OUT"] = 26] = "DST_OUT";
    BLEND_MODES2[BLEND_MODES2["DST_ATOP"] = 27] = "DST_ATOP";
    BLEND_MODES2[BLEND_MODES2["ERASE"] = 26] = "ERASE";
    BLEND_MODES2[BLEND_MODES2["SUBTRACT"] = 28] = "SUBTRACT";
    BLEND_MODES2[BLEND_MODES2["XOR"] = 29] = "XOR";
  })(BLEND_MODES || (BLEND_MODES = {}));
  var DRAW_MODES;
  (function(DRAW_MODES2) {
    DRAW_MODES2[DRAW_MODES2["POINTS"] = 0] = "POINTS";
    DRAW_MODES2[DRAW_MODES2["LINES"] = 1] = "LINES";
    DRAW_MODES2[DRAW_MODES2["LINE_LOOP"] = 2] = "LINE_LOOP";
    DRAW_MODES2[DRAW_MODES2["LINE_STRIP"] = 3] = "LINE_STRIP";
    DRAW_MODES2[DRAW_MODES2["TRIANGLES"] = 4] = "TRIANGLES";
    DRAW_MODES2[DRAW_MODES2["TRIANGLE_STRIP"] = 5] = "TRIANGLE_STRIP";
    DRAW_MODES2[DRAW_MODES2["TRIANGLE_FAN"] = 6] = "TRIANGLE_FAN";
  })(DRAW_MODES || (DRAW_MODES = {}));
  var FORMATS;
  (function(FORMATS2) {
    FORMATS2[FORMATS2["RGBA"] = 6408] = "RGBA";
    FORMATS2[FORMATS2["RGB"] = 6407] = "RGB";
    FORMATS2[FORMATS2["RG"] = 33319] = "RG";
    FORMATS2[FORMATS2["RED"] = 6403] = "RED";
    FORMATS2[FORMATS2["RGBA_INTEGER"] = 36249] = "RGBA_INTEGER";
    FORMATS2[FORMATS2["RGB_INTEGER"] = 36248] = "RGB_INTEGER";
    FORMATS2[FORMATS2["RG_INTEGER"] = 33320] = "RG_INTEGER";
    FORMATS2[FORMATS2["RED_INTEGER"] = 36244] = "RED_INTEGER";
    FORMATS2[FORMATS2["ALPHA"] = 6406] = "ALPHA";
    FORMATS2[FORMATS2["LUMINANCE"] = 6409] = "LUMINANCE";
    FORMATS2[FORMATS2["LUMINANCE_ALPHA"] = 6410] = "LUMINANCE_ALPHA";
    FORMATS2[FORMATS2["DEPTH_COMPONENT"] = 6402] = "DEPTH_COMPONENT";
    FORMATS2[FORMATS2["DEPTH_STENCIL"] = 34041] = "DEPTH_STENCIL";
  })(FORMATS || (FORMATS = {}));
  var TARGETS;
  (function(TARGETS2) {
    TARGETS2[TARGETS2["TEXTURE_2D"] = 3553] = "TEXTURE_2D";
    TARGETS2[TARGETS2["TEXTURE_CUBE_MAP"] = 34067] = "TEXTURE_CUBE_MAP";
    TARGETS2[TARGETS2["TEXTURE_2D_ARRAY"] = 35866] = "TEXTURE_2D_ARRAY";
    TARGETS2[TARGETS2["TEXTURE_CUBE_MAP_POSITIVE_X"] = 34069] = "TEXTURE_CUBE_MAP_POSITIVE_X";
    TARGETS2[TARGETS2["TEXTURE_CUBE_MAP_NEGATIVE_X"] = 34070] = "TEXTURE_CUBE_MAP_NEGATIVE_X";
    TARGETS2[TARGETS2["TEXTURE_CUBE_MAP_POSITIVE_Y"] = 34071] = "TEXTURE_CUBE_MAP_POSITIVE_Y";
    TARGETS2[TARGETS2["TEXTURE_CUBE_MAP_NEGATIVE_Y"] = 34072] = "TEXTURE_CUBE_MAP_NEGATIVE_Y";
    TARGETS2[TARGETS2["TEXTURE_CUBE_MAP_POSITIVE_Z"] = 34073] = "TEXTURE_CUBE_MAP_POSITIVE_Z";
    TARGETS2[TARGETS2["TEXTURE_CUBE_MAP_NEGATIVE_Z"] = 34074] = "TEXTURE_CUBE_MAP_NEGATIVE_Z";
  })(TARGETS || (TARGETS = {}));
  var TYPES;
  (function(TYPES2) {
    TYPES2[TYPES2["UNSIGNED_BYTE"] = 5121] = "UNSIGNED_BYTE";
    TYPES2[TYPES2["UNSIGNED_SHORT"] = 5123] = "UNSIGNED_SHORT";
    TYPES2[TYPES2["UNSIGNED_SHORT_5_6_5"] = 33635] = "UNSIGNED_SHORT_5_6_5";
    TYPES2[TYPES2["UNSIGNED_SHORT_4_4_4_4"] = 32819] = "UNSIGNED_SHORT_4_4_4_4";
    TYPES2[TYPES2["UNSIGNED_SHORT_5_5_5_1"] = 32820] = "UNSIGNED_SHORT_5_5_5_1";
    TYPES2[TYPES2["UNSIGNED_INT"] = 5125] = "UNSIGNED_INT";
    TYPES2[TYPES2["UNSIGNED_INT_10F_11F_11F_REV"] = 35899] = "UNSIGNED_INT_10F_11F_11F_REV";
    TYPES2[TYPES2["UNSIGNED_INT_2_10_10_10_REV"] = 33640] = "UNSIGNED_INT_2_10_10_10_REV";
    TYPES2[TYPES2["UNSIGNED_INT_24_8"] = 34042] = "UNSIGNED_INT_24_8";
    TYPES2[TYPES2["UNSIGNED_INT_5_9_9_9_REV"] = 35902] = "UNSIGNED_INT_5_9_9_9_REV";
    TYPES2[TYPES2["BYTE"] = 5120] = "BYTE";
    TYPES2[TYPES2["SHORT"] = 5122] = "SHORT";
    TYPES2[TYPES2["INT"] = 5124] = "INT";
    TYPES2[TYPES2["FLOAT"] = 5126] = "FLOAT";
    TYPES2[TYPES2["FLOAT_32_UNSIGNED_INT_24_8_REV"] = 36269] = "FLOAT_32_UNSIGNED_INT_24_8_REV";
    TYPES2[TYPES2["HALF_FLOAT"] = 36193] = "HALF_FLOAT";
  })(TYPES || (TYPES = {}));
  var SAMPLER_TYPES;
  (function(SAMPLER_TYPES2) {
    SAMPLER_TYPES2[SAMPLER_TYPES2["FLOAT"] = 0] = "FLOAT";
    SAMPLER_TYPES2[SAMPLER_TYPES2["INT"] = 1] = "INT";
    SAMPLER_TYPES2[SAMPLER_TYPES2["UINT"] = 2] = "UINT";
  })(SAMPLER_TYPES || (SAMPLER_TYPES = {}));
  var SCALE_MODES;
  (function(SCALE_MODES2) {
    SCALE_MODES2[SCALE_MODES2["NEAREST"] = 0] = "NEAREST";
    SCALE_MODES2[SCALE_MODES2["LINEAR"] = 1] = "LINEAR";
  })(SCALE_MODES || (SCALE_MODES = {}));
  var WRAP_MODES;
  (function(WRAP_MODES2) {
    WRAP_MODES2[WRAP_MODES2["CLAMP"] = 33071] = "CLAMP";
    WRAP_MODES2[WRAP_MODES2["REPEAT"] = 10497] = "REPEAT";
    WRAP_MODES2[WRAP_MODES2["MIRRORED_REPEAT"] = 33648] = "MIRRORED_REPEAT";
  })(WRAP_MODES || (WRAP_MODES = {}));
  var MIPMAP_MODES;
  (function(MIPMAP_MODES2) {
    MIPMAP_MODES2[MIPMAP_MODES2["OFF"] = 0] = "OFF";
    MIPMAP_MODES2[MIPMAP_MODES2["POW2"] = 1] = "POW2";
    MIPMAP_MODES2[MIPMAP_MODES2["ON"] = 2] = "ON";
    MIPMAP_MODES2[MIPMAP_MODES2["ON_MANUAL"] = 3] = "ON_MANUAL";
  })(MIPMAP_MODES || (MIPMAP_MODES = {}));
  var ALPHA_MODES;
  (function(ALPHA_MODES2) {
    ALPHA_MODES2[ALPHA_MODES2["NPM"] = 0] = "NPM";
    ALPHA_MODES2[ALPHA_MODES2["UNPACK"] = 1] = "UNPACK";
    ALPHA_MODES2[ALPHA_MODES2["PMA"] = 2] = "PMA";
    ALPHA_MODES2[ALPHA_MODES2["NO_PREMULTIPLIED_ALPHA"] = 0] = "NO_PREMULTIPLIED_ALPHA";
    ALPHA_MODES2[ALPHA_MODES2["PREMULTIPLY_ON_UPLOAD"] = 1] = "PREMULTIPLY_ON_UPLOAD";
    ALPHA_MODES2[ALPHA_MODES2["PREMULTIPLY_ALPHA"] = 2] = "PREMULTIPLY_ALPHA";
    ALPHA_MODES2[ALPHA_MODES2["PREMULTIPLIED_ALPHA"] = 2] = "PREMULTIPLIED_ALPHA";
  })(ALPHA_MODES || (ALPHA_MODES = {}));
  var CLEAR_MODES;
  (function(CLEAR_MODES2) {
    CLEAR_MODES2[CLEAR_MODES2["NO"] = 0] = "NO";
    CLEAR_MODES2[CLEAR_MODES2["YES"] = 1] = "YES";
    CLEAR_MODES2[CLEAR_MODES2["AUTO"] = 2] = "AUTO";
    CLEAR_MODES2[CLEAR_MODES2["BLEND"] = 0] = "BLEND";
    CLEAR_MODES2[CLEAR_MODES2["CLEAR"] = 1] = "CLEAR";
    CLEAR_MODES2[CLEAR_MODES2["BLIT"] = 2] = "BLIT";
  })(CLEAR_MODES || (CLEAR_MODES = {}));
  var GC_MODES;
  (function(GC_MODES2) {
    GC_MODES2[GC_MODES2["AUTO"] = 0] = "AUTO";
    GC_MODES2[GC_MODES2["MANUAL"] = 1] = "MANUAL";
  })(GC_MODES || (GC_MODES = {}));
  var PRECISION;
  (function(PRECISION2) {
    PRECISION2["LOW"] = "lowp";
    PRECISION2["MEDIUM"] = "mediump";
    PRECISION2["HIGH"] = "highp";
  })(PRECISION || (PRECISION = {}));
  var MASK_TYPES;
  (function(MASK_TYPES2) {
    MASK_TYPES2[MASK_TYPES2["NONE"] = 0] = "NONE";
    MASK_TYPES2[MASK_TYPES2["SCISSOR"] = 1] = "SCISSOR";
    MASK_TYPES2[MASK_TYPES2["STENCIL"] = 2] = "STENCIL";
    MASK_TYPES2[MASK_TYPES2["SPRITE"] = 3] = "SPRITE";
    MASK_TYPES2[MASK_TYPES2["COLOR"] = 4] = "COLOR";
  })(MASK_TYPES || (MASK_TYPES = {}));
  var COLOR_MASK_BITS;
  (function(COLOR_MASK_BITS2) {
    COLOR_MASK_BITS2[COLOR_MASK_BITS2["RED"] = 1] = "RED";
    COLOR_MASK_BITS2[COLOR_MASK_BITS2["GREEN"] = 2] = "GREEN";
    COLOR_MASK_BITS2[COLOR_MASK_BITS2["BLUE"] = 4] = "BLUE";
    COLOR_MASK_BITS2[COLOR_MASK_BITS2["ALPHA"] = 8] = "ALPHA";
  })(COLOR_MASK_BITS || (COLOR_MASK_BITS = {}));
  var MSAA_QUALITY;
  (function(MSAA_QUALITY2) {
    MSAA_QUALITY2[MSAA_QUALITY2["NONE"] = 0] = "NONE";
    MSAA_QUALITY2[MSAA_QUALITY2["LOW"] = 2] = "LOW";
    MSAA_QUALITY2[MSAA_QUALITY2["MEDIUM"] = 4] = "MEDIUM";
    MSAA_QUALITY2[MSAA_QUALITY2["HIGH"] = 8] = "HIGH";
  })(MSAA_QUALITY || (MSAA_QUALITY = {}));
  var BUFFER_TYPE;
  (function(BUFFER_TYPE2) {
    BUFFER_TYPE2[BUFFER_TYPE2["ELEMENT_ARRAY_BUFFER"] = 34963] = "ELEMENT_ARRAY_BUFFER";
    BUFFER_TYPE2[BUFFER_TYPE2["ARRAY_BUFFER"] = 34962] = "ARRAY_BUFFER";
    BUFFER_TYPE2[BUFFER_TYPE2["UNIFORM_BUFFER"] = 35345] = "UNIFORM_BUFFER";
  })(BUFFER_TYPE || (BUFFER_TYPE = {}));

  // node_modules/@pixi/settings/dist/esm/settings.mjs
  var BrowserAdapter = {
    /**
     * Creates a canvas element of the given size.
     * This canvas is created using the browser's native canvas element.
     * @param width - width of the canvas
     * @param height - height of the canvas
     */
    createCanvas: function(width, height) {
      var canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas;
    },
    getWebGLRenderingContext: function() {
      return WebGLRenderingContext;
    },
    getNavigator: function() {
      return navigator;
    },
    getBaseUrl: function() {
      var _a;
      return (_a = document.baseURI) !== null && _a !== void 0 ? _a : window.location.href;
    },
    fetch: function(url2, options) {
      return fetch(url2, options);
    }
  };
  var appleIphone = /iPhone/i;
  var appleIpod = /iPod/i;
  var appleTablet = /iPad/i;
  var appleUniversal = /\biOS-universal(?:.+)Mac\b/i;
  var androidPhone = /\bAndroid(?:.+)Mobile\b/i;
  var androidTablet = /Android/i;
  var amazonPhone = /(?:SD4930UR|\bSilk(?:.+)Mobile\b)/i;
  var amazonTablet = /Silk/i;
  var windowsPhone = /Windows Phone/i;
  var windowsTablet = /\bWindows(?:.+)ARM\b/i;
  var otherBlackBerry = /BlackBerry/i;
  var otherBlackBerry10 = /BB10/i;
  var otherOpera = /Opera Mini/i;
  var otherChrome = /\b(CriOS|Chrome)(?:.+)Mobile/i;
  var otherFirefox = /Mobile(?:.+)Firefox\b/i;
  var isAppleTabletOnIos13 = function(navigator2) {
    return typeof navigator2 !== "undefined" && navigator2.platform === "MacIntel" && typeof navigator2.maxTouchPoints === "number" && navigator2.maxTouchPoints > 1 && typeof MSStream === "undefined";
  };
  function createMatch(userAgent) {
    return function(regex) {
      return regex.test(userAgent);
    };
  }
  function isMobile$1(param) {
    var nav = {
      userAgent: "",
      platform: "",
      maxTouchPoints: 0
    };
    if (!param && typeof navigator !== "undefined") {
      nav = {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        maxTouchPoints: navigator.maxTouchPoints || 0
      };
    } else if (typeof param === "string") {
      nav.userAgent = param;
    } else if (param && param.userAgent) {
      nav = {
        userAgent: param.userAgent,
        platform: param.platform,
        maxTouchPoints: param.maxTouchPoints || 0
      };
    }
    var userAgent = nav.userAgent;
    var tmp = userAgent.split("[FBAN");
    if (typeof tmp[1] !== "undefined") {
      userAgent = tmp[0];
    }
    tmp = userAgent.split("Twitter");
    if (typeof tmp[1] !== "undefined") {
      userAgent = tmp[0];
    }
    var match = createMatch(userAgent);
    var result = {
      apple: {
        phone: match(appleIphone) && !match(windowsPhone),
        ipod: match(appleIpod),
        tablet: !match(appleIphone) && (match(appleTablet) || isAppleTabletOnIos13(nav)) && !match(windowsPhone),
        universal: match(appleUniversal),
        device: (match(appleIphone) || match(appleIpod) || match(appleTablet) || match(appleUniversal) || isAppleTabletOnIos13(nav)) && !match(windowsPhone)
      },
      amazon: {
        phone: match(amazonPhone),
        tablet: !match(amazonPhone) && match(amazonTablet),
        device: match(amazonPhone) || match(amazonTablet)
      },
      android: {
        phone: !match(windowsPhone) && match(amazonPhone) || !match(windowsPhone) && match(androidPhone),
        tablet: !match(windowsPhone) && !match(amazonPhone) && !match(androidPhone) && (match(amazonTablet) || match(androidTablet)),
        device: !match(windowsPhone) && (match(amazonPhone) || match(amazonTablet) || match(androidPhone) || match(androidTablet)) || match(/\bokhttp\b/i)
      },
      windows: {
        phone: match(windowsPhone),
        tablet: match(windowsTablet),
        device: match(windowsPhone) || match(windowsTablet)
      },
      other: {
        blackberry: match(otherBlackBerry),
        blackberry10: match(otherBlackBerry10),
        opera: match(otherOpera),
        firefox: match(otherFirefox),
        chrome: match(otherChrome),
        device: match(otherBlackBerry) || match(otherBlackBerry10) || match(otherOpera) || match(otherFirefox) || match(otherChrome)
      },
      any: false,
      phone: false,
      tablet: false
    };
    result.any = result.apple.device || result.android.device || result.windows.device || result.other.device;
    result.phone = result.apple.phone || result.android.phone || result.windows.phone;
    result.tablet = result.apple.tablet || result.android.tablet || result.windows.tablet;
    return result;
  }
  var isMobile = isMobile$1(globalThis.navigator);
  function canUploadSameBuffer() {
    return !isMobile.apple.device;
  }
  function maxRecommendedTextures(max) {
    var allowMax = true;
    if (isMobile.tablet || isMobile.phone) {
      if (isMobile.apple.device) {
        var match = navigator.userAgent.match(/OS (\d+)_(\d+)?/);
        if (match) {
          var majorVersion = parseInt(match[1], 10);
          if (majorVersion < 11) {
            allowMax = false;
          }
        }
      }
      if (isMobile.android.device) {
        var match = navigator.userAgent.match(/Android\s([0-9.]*)/);
        if (match) {
          var majorVersion = parseInt(match[1], 10);
          if (majorVersion < 7) {
            allowMax = false;
          }
        }
      }
    }
    return allowMax ? max : 4;
  }
  var settings = {
    /**
     * This adapter is used to call methods that are platform dependent.
     * For example `document.createElement` only runs on the web but fails in node environments.
     * This allows us to support more platforms by abstracting away specific implementations per platform.
     *
     * By default the adapter is set to work in the browser. However you can create your own
     * by implementing the `IAdapter` interface. See `IAdapter` for more information.
     * @name ADAPTER
     * @memberof PIXI.settings
     * @type {PIXI.IAdapter}
     * @default PIXI.BrowserAdapter
     */
    ADAPTER: BrowserAdapter,
    /**
     * If set to true WebGL will attempt make textures mimpaped by default.
     * Mipmapping will only succeed if the base texture uploaded has power of two dimensions.
     * @static
     * @name MIPMAP_TEXTURES
     * @memberof PIXI.settings
     * @type {PIXI.MIPMAP_MODES}
     * @default PIXI.MIPMAP_MODES.POW2
     */
    MIPMAP_TEXTURES: MIPMAP_MODES.POW2,
    /**
     * Default anisotropic filtering level of textures.
     * Usually from 0 to 16
     * @static
     * @name ANISOTROPIC_LEVEL
     * @memberof PIXI.settings
     * @type {number}
     * @default 0
     */
    ANISOTROPIC_LEVEL: 0,
    /**
     * Default resolution / device pixel ratio of the renderer.
     * @static
     * @name RESOLUTION
     * @memberof PIXI.settings
     * @type {number}
     * @default 1
     */
    RESOLUTION: 1,
    /**
     * Default filter resolution.
     * @static
     * @name FILTER_RESOLUTION
     * @memberof PIXI.settings
     * @type {number}
     * @default 1
     */
    FILTER_RESOLUTION: 1,
    /**
     * Default filter samples.
     * @static
     * @name FILTER_MULTISAMPLE
     * @memberof PIXI.settings
     * @type {PIXI.MSAA_QUALITY}
     * @default PIXI.MSAA_QUALITY.NONE
     */
    FILTER_MULTISAMPLE: MSAA_QUALITY.NONE,
    /**
     * The maximum textures that this device supports.
     * @static
     * @name SPRITE_MAX_TEXTURES
     * @memberof PIXI.settings
     * @type {number}
     * @default 32
     */
    SPRITE_MAX_TEXTURES: maxRecommendedTextures(32),
    // TODO: maybe change to SPRITE.BATCH_SIZE: 2000
    // TODO: maybe add PARTICLE.BATCH_SIZE: 15000
    /**
     * The default sprite batch size.
     *
     * The default aims to balance desktop and mobile devices.
     * @static
     * @name SPRITE_BATCH_SIZE
     * @memberof PIXI.settings
     * @type {number}
     * @default 4096
     */
    SPRITE_BATCH_SIZE: 4096,
    /**
     * The default render options if none are supplied to {@link PIXI.Renderer}
     * or {@link PIXI.CanvasRenderer}.
     * @static
     * @name RENDER_OPTIONS
     * @memberof PIXI.settings
     * @type {object}
     * @property {boolean} [antialias=false] - {@link PIXI.IRendererOptions.antialias}
     * @property {boolean} [autoDensity=false] - {@link PIXI.IRendererOptions.autoDensity}
     * @property {number} [backgroundAlpha=1] - {@link PIXI.IRendererOptions.backgroundAlpha}
     * @property {number} [backgroundColor=0x000000] - {@link PIXI.IRendererOptions.backgroundColor}
     * @property {boolean} [clearBeforeRender=true] - {@link PIXI.IRendererOptions.clearBeforeRender}
     * @property {number} [height=600] - {@link PIXI.IRendererOptions.height}
     * @property {boolean} [preserveDrawingBuffer=false] - {@link PIXI.IRendererOptions.preserveDrawingBuffer}
     * @property {boolean|'notMultiplied'} [useContextAlpha=true] - {@link PIXI.IRendererOptions.useContextAlpha}
     * @property {HTMLCanvasElement} [view=null] - {@link PIXI.IRendererOptions.view}
     * @property {number} [width=800] - {@link PIXI.IRendererOptions.width}
     */
    RENDER_OPTIONS: {
      view: null,
      width: 800,
      height: 600,
      autoDensity: false,
      backgroundColor: 0,
      backgroundAlpha: 1,
      useContextAlpha: true,
      clearBeforeRender: true,
      antialias: false,
      preserveDrawingBuffer: false
    },
    /**
     * Default Garbage Collection mode.
     * @static
     * @name GC_MODE
     * @memberof PIXI.settings
     * @type {PIXI.GC_MODES}
     * @default PIXI.GC_MODES.AUTO
     */
    GC_MODE: GC_MODES.AUTO,
    /**
     * Default Garbage Collection max idle.
     * @static
     * @name GC_MAX_IDLE
     * @memberof PIXI.settings
     * @type {number}
     * @default 3600
     */
    GC_MAX_IDLE: 60 * 60,
    /**
     * Default Garbage Collection maximum check count.
     * @static
     * @name GC_MAX_CHECK_COUNT
     * @memberof PIXI.settings
     * @type {number}
     * @default 600
     */
    GC_MAX_CHECK_COUNT: 60 * 10,
    /**
     * Default wrap modes that are supported by pixi.
     * @static
     * @name WRAP_MODE
     * @memberof PIXI.settings
     * @type {PIXI.WRAP_MODES}
     * @default PIXI.WRAP_MODES.CLAMP
     */
    WRAP_MODE: WRAP_MODES.CLAMP,
    /**
     * Default scale mode for textures.
     * @static
     * @name SCALE_MODE
     * @memberof PIXI.settings
     * @type {PIXI.SCALE_MODES}
     * @default PIXI.SCALE_MODES.LINEAR
     */
    SCALE_MODE: SCALE_MODES.LINEAR,
    /**
     * Default specify float precision in vertex shader.
     * @static
     * @name PRECISION_VERTEX
     * @memberof PIXI.settings
     * @type {PIXI.PRECISION}
     * @default PIXI.PRECISION.HIGH
     */
    PRECISION_VERTEX: PRECISION.HIGH,
    /**
     * Default specify float precision in fragment shader.
     * iOS is best set at highp due to https://github.com/pixijs/pixi.js/issues/3742
     * @static
     * @name PRECISION_FRAGMENT
     * @memberof PIXI.settings
     * @type {PIXI.PRECISION}
     * @default PIXI.PRECISION.MEDIUM
     */
    PRECISION_FRAGMENT: isMobile.apple.device ? PRECISION.HIGH : PRECISION.MEDIUM,
    /**
     * Can we upload the same buffer in a single frame?
     * @static
     * @name CAN_UPLOAD_SAME_BUFFER
     * @memberof PIXI.settings
     * @type {boolean}
     */
    CAN_UPLOAD_SAME_BUFFER: canUploadSameBuffer(),
    /**
     * Enables bitmap creation before image load. This feature is experimental.
     * @static
     * @name CREATE_IMAGE_BITMAP
     * @memberof PIXI.settings
     * @type {boolean}
     * @default false
     */
    CREATE_IMAGE_BITMAP: false,
    /**
     * If true PixiJS will Math.floor() x/y values when rendering, stopping pixel interpolation.
     * Advantages can include sharper image quality (like text) and faster rendering on canvas.
     * The main disadvantage is movement of objects may appear less smooth.
     * @static
     * @constant
     * @memberof PIXI.settings
     * @type {boolean}
     * @default false
     */
    ROUND_PIXELS: false
  };

  // node_modules/@pixi/utils/dist/esm/utils.mjs
  var import_eventemitter3 = __toESM(require_eventemitter3(), 1);
  var import_earcut = __toESM(require_earcut(), 1);
  var import_url = __toESM(require_url(), 1);
  var url = {
    parse: import_url.parse,
    format: import_url.format,
    resolve: import_url.resolve
  };
  settings.RETINA_PREFIX = /@([0-9\.]+)x/;
  settings.FAIL_IF_MAJOR_PERFORMANCE_CAVEAT = false;
  var saidHello = false;
  var VERSION = "6.5.10";
  function sayHello(type) {
    var _a;
    if (saidHello) {
      return;
    }
    if (settings.ADAPTER.getNavigator().userAgent.toLowerCase().indexOf("chrome") > -1) {
      var args = [
        "\n %c %c %c PixiJS " + VERSION + " - \u2730 " + type + " \u2730  %c  %c  http://www.pixijs.com/  %c %c \u2665%c\u2665%c\u2665 \n\n",
        "background: #ff66a5; padding:5px 0;",
        "background: #ff66a5; padding:5px 0;",
        "color: #ff66a5; background: #030307; padding:5px 0;",
        "background: #ff66a5; padding:5px 0;",
        "background: #ffc3dc; padding:5px 0;",
        "background: #ff66a5; padding:5px 0;",
        "color: #ff2424; background: #fff; padding:5px 0;",
        "color: #ff2424; background: #fff; padding:5px 0;",
        "color: #ff2424; background: #fff; padding:5px 0;"
      ];
      (_a = globalThis.console).log.apply(_a, args);
    } else if (globalThis.console) {
      globalThis.console.log("PixiJS " + VERSION + " - " + type + " - http://www.pixijs.com/");
    }
    saidHello = true;
  }
  var supported;
  function isWebGLSupported() {
    if (typeof supported === "undefined") {
      supported = (function supported2() {
        var contextOptions = {
          stencil: true,
          failIfMajorPerformanceCaveat: settings.FAIL_IF_MAJOR_PERFORMANCE_CAVEAT
        };
        try {
          if (!settings.ADAPTER.getWebGLRenderingContext()) {
            return false;
          }
          var canvas = settings.ADAPTER.createCanvas();
          var gl = canvas.getContext("webgl", contextOptions) || canvas.getContext("experimental-webgl", contextOptions);
          var success = !!(gl && gl.getContextAttributes().stencil);
          if (gl) {
            var loseContext = gl.getExtension("WEBGL_lose_context");
            if (loseContext) {
              loseContext.loseContext();
            }
          }
          gl = null;
          return success;
        } catch (e) {
          return false;
        }
      })();
    }
    return supported;
  }
  function hex2rgb(hex, out) {
    if (out === void 0) {
      out = [];
    }
    out[0] = (hex >> 16 & 255) / 255;
    out[1] = (hex >> 8 & 255) / 255;
    out[2] = (hex & 255) / 255;
    return out;
  }
  function hex2string(hex) {
    var hexString = hex.toString(16);
    hexString = "000000".substring(0, 6 - hexString.length) + hexString;
    return "#" + hexString;
  }
  function mapPremultipliedBlendModes() {
    var pm = [];
    var npm = [];
    for (var i = 0; i < 32; i++) {
      pm[i] = i;
      npm[i] = i;
    }
    pm[BLEND_MODES.NORMAL_NPM] = BLEND_MODES.NORMAL;
    pm[BLEND_MODES.ADD_NPM] = BLEND_MODES.ADD;
    pm[BLEND_MODES.SCREEN_NPM] = BLEND_MODES.SCREEN;
    npm[BLEND_MODES.NORMAL] = BLEND_MODES.NORMAL_NPM;
    npm[BLEND_MODES.ADD] = BLEND_MODES.ADD_NPM;
    npm[BLEND_MODES.SCREEN] = BLEND_MODES.SCREEN_NPM;
    var array = [];
    array.push(npm);
    array.push(pm);
    return array;
  }
  var premultiplyBlendMode = mapPremultipliedBlendModes();
  function premultiplyTint(tint, alpha) {
    if (alpha === 1) {
      return (alpha * 255 << 24) + tint;
    }
    if (alpha === 0) {
      return 0;
    }
    var R = tint >> 16 & 255;
    var G = tint >> 8 & 255;
    var B = tint & 255;
    R = R * alpha + 0.5 | 0;
    G = G * alpha + 0.5 | 0;
    B = B * alpha + 0.5 | 0;
    return (alpha * 255 << 24) + (R << 16) + (G << 8) + B;
  }
  function getBufferType(array) {
    if (array.BYTES_PER_ELEMENT === 4) {
      if (array instanceof Float32Array) {
        return "Float32Array";
      } else if (array instanceof Uint32Array) {
        return "Uint32Array";
      }
      return "Int32Array";
    } else if (array.BYTES_PER_ELEMENT === 2) {
      if (array instanceof Uint16Array) {
        return "Uint16Array";
      }
    } else if (array.BYTES_PER_ELEMENT === 1) {
      if (array instanceof Uint8Array) {
        return "Uint8Array";
      }
    }
    return null;
  }
  function nextPow2(v) {
    v += v === 0 ? 1 : 0;
    --v;
    v |= v >>> 1;
    v |= v >>> 2;
    v |= v >>> 4;
    v |= v >>> 8;
    v |= v >>> 16;
    return v + 1;
  }
  function isPow2(v) {
    return !(v & v - 1) && !!v;
  }
  function log2(v) {
    var r = (v > 65535 ? 1 : 0) << 4;
    v >>>= r;
    var shift = (v > 255 ? 1 : 0) << 3;
    v >>>= shift;
    r |= shift;
    shift = (v > 15 ? 1 : 0) << 2;
    v >>>= shift;
    r |= shift;
    shift = (v > 3 ? 1 : 0) << 1;
    v >>>= shift;
    r |= shift;
    return r | v >> 1;
  }
  function removeItems(arr, startIdx, removeCount) {
    var length = arr.length;
    var i;
    if (startIdx >= length || removeCount === 0) {
      return;
    }
    removeCount = startIdx + removeCount > length ? length - startIdx : removeCount;
    var len = length - removeCount;
    for (i = startIdx; i < len; ++i) {
      arr[i] = arr[i + removeCount];
    }
    arr.length = len;
  }
  var nextUid = 0;
  function uid() {
    return ++nextUid;
  }
  var warnings = {};
  function deprecation(version, message, ignoreDepth) {
    if (ignoreDepth === void 0) {
      ignoreDepth = 3;
    }
    if (warnings[message]) {
      return;
    }
    var stack = new Error().stack;
    if (typeof stack === "undefined") {
      console.warn("PixiJS Deprecation Warning: ", message + "\nDeprecated since v" + version);
    } else {
      stack = stack.split("\n").splice(ignoreDepth).join("\n");
      if (console.groupCollapsed) {
        console.groupCollapsed("%cPixiJS Deprecation Warning: %c%s", "color:#614108;background:#fffbe6", "font-weight:normal;color:#614108;background:#fffbe6", message + "\nDeprecated since v" + version);
        console.warn(stack);
        console.groupEnd();
      } else {
        console.warn("PixiJS Deprecation Warning: ", message + "\nDeprecated since v" + version);
        console.warn(stack);
      }
    }
    warnings[message] = true;
  }
  var ProgramCache = {};
  var TextureCache = /* @__PURE__ */ Object.create(null);
  var BaseTextureCache = /* @__PURE__ */ Object.create(null);
  var CanvasRenderTarget = (
    /** @class */
    (function() {
      function CanvasRenderTarget2(width, height, resolution) {
        this.canvas = settings.ADAPTER.createCanvas();
        this.context = this.canvas.getContext("2d");
        this.resolution = resolution || settings.RESOLUTION;
        this.resize(width, height);
      }
      CanvasRenderTarget2.prototype.clear = function() {
        this.context.setTransform(1, 0, 0, 1, 0, 0);
        this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      };
      CanvasRenderTarget2.prototype.resize = function(desiredWidth, desiredHeight) {
        this.canvas.width = Math.round(desiredWidth * this.resolution);
        this.canvas.height = Math.round(desiredHeight * this.resolution);
      };
      CanvasRenderTarget2.prototype.destroy = function() {
        this.context = null;
        this.canvas = null;
      };
      Object.defineProperty(CanvasRenderTarget2.prototype, "width", {
        /**
         * The width of the canvas buffer in pixels.
         * @member {number}
         */
        get: function() {
          return this.canvas.width;
        },
        set: function(val) {
          this.canvas.width = Math.round(val);
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(CanvasRenderTarget2.prototype, "height", {
        /**
         * The height of the canvas buffer in pixels.
         * @member {number}
         */
        get: function() {
          return this.canvas.height;
        },
        set: function(val) {
          this.canvas.height = Math.round(val);
        },
        enumerable: false,
        configurable: true
      });
      return CanvasRenderTarget2;
    })()
  );
  var tempAnchor;
  function determineCrossOrigin(url$1, loc) {
    if (loc === void 0) {
      loc = globalThis.location;
    }
    if (url$1.indexOf("data:") === 0) {
      return "";
    }
    loc = loc || globalThis.location;
    if (!tempAnchor) {
      tempAnchor = document.createElement("a");
    }
    tempAnchor.href = url$1;
    var parsedUrl = url.parse(tempAnchor.href);
    var samePort = !parsedUrl.port && loc.port === "" || parsedUrl.port === loc.port;
    if (parsedUrl.hostname !== loc.hostname || !samePort || parsedUrl.protocol !== loc.protocol) {
      return "anonymous";
    }
    return "";
  }
  function getResolutionOfUrl(url2, defaultValue2) {
    var resolution = settings.RETINA_PREFIX.exec(url2);
    if (resolution) {
      return parseFloat(resolution[1]);
    }
    return defaultValue2 !== void 0 ? defaultValue2 : 1;
  }

  // node_modules/@pixi/extensions/dist/esm/extensions.mjs
  var __assign = function() {
    __assign = Object.assign || function __assign3(t) {
      var arguments$1 = arguments;
      for (var s, i = 1, n = arguments.length; i < n; i++) {
        s = arguments$1[i];
        for (var p in s) {
          if (Object.prototype.hasOwnProperty.call(s, p)) {
            t[p] = s[p];
          }
        }
      }
      return t;
    };
    return __assign.apply(this, arguments);
  };
  var ExtensionType;
  (function(ExtensionType2) {
    ExtensionType2["Application"] = "application";
    ExtensionType2["RendererPlugin"] = "renderer-webgl-plugin";
    ExtensionType2["CanvasRendererPlugin"] = "renderer-canvas-plugin";
    ExtensionType2["Loader"] = "loader";
    ExtensionType2["LoadParser"] = "load-parser";
    ExtensionType2["ResolveParser"] = "resolve-parser";
    ExtensionType2["CacheParser"] = "cache-parser";
    ExtensionType2["DetectionParser"] = "detection-parser";
  })(ExtensionType || (ExtensionType = {}));
  var normalizeExtension = function(ext) {
    if (typeof ext === "function" || typeof ext === "object" && ext.extension) {
      if (!ext.extension) {
        throw new Error("Extension class must have an extension object");
      }
      var metadata = typeof ext.extension !== "object" ? { type: ext.extension } : ext.extension;
      ext = __assign(__assign({}, metadata), { ref: ext });
    }
    if (typeof ext === "object") {
      ext = __assign({}, ext);
    } else {
      throw new Error("Invalid extension type");
    }
    if (typeof ext.type === "string") {
      ext.type = [ext.type];
    }
    return ext;
  };
  var extensions = {
    /** @ignore */
    _addHandlers: null,
    /** @ignore */
    _removeHandlers: null,
    /** @ignore */
    _queue: {},
    /**
     * Remove extensions from PixiJS.
     * @param extensions - Extensions to be removed.
     * @returns {PIXI.extensions} For chaining.
     */
    remove: function() {
      var arguments$1 = arguments;
      var _this = this;
      var extensions2 = [];
      for (var _i = 0; _i < arguments.length; _i++) {
        extensions2[_i] = arguments$1[_i];
      }
      extensions2.map(normalizeExtension).forEach(function(ext) {
        ext.type.forEach(function(type) {
          var _a, _b;
          return (_b = (_a = _this._removeHandlers)[type]) === null || _b === void 0 ? void 0 : _b.call(_a, ext);
        });
      });
      return this;
    },
    /**
     * Register new extensions with PixiJS.
     * @param extensions - The spread of extensions to add to PixiJS.
     * @returns {PIXI.extensions} For chaining.
     */
    add: function() {
      var arguments$1 = arguments;
      var _this = this;
      var extensions2 = [];
      for (var _i = 0; _i < arguments.length; _i++) {
        extensions2[_i] = arguments$1[_i];
      }
      extensions2.map(normalizeExtension).forEach(function(ext) {
        ext.type.forEach(function(type) {
          var handlers = _this._addHandlers;
          var queue = _this._queue;
          if (!handlers[type]) {
            queue[type] = queue[type] || [];
            queue[type].push(ext);
          } else {
            handlers[type](ext);
          }
        });
      });
      return this;
    },
    /**
     * Internal method to handle extensions by name.
     * @param type - The extension type.
     * @param onAdd  - Function for handling when extensions are added/registered passes {@link PIXI.ExtensionFormat}.
     * @param onRemove  - Function for handling when extensions are removed/unregistered passes {@link PIXI.ExtensionFormat}.
     * @returns {PIXI.extensions} For chaining.
     */
    handle: function(type, onAdd, onRemove) {
      var addHandlers = this._addHandlers = this._addHandlers || {};
      var removeHandlers = this._removeHandlers = this._removeHandlers || {};
      if (addHandlers[type] || removeHandlers[type]) {
        throw new Error("Extension type " + type + " already has a handler");
      }
      addHandlers[type] = onAdd;
      removeHandlers[type] = onRemove;
      var queue = this._queue;
      if (queue[type]) {
        queue[type].forEach(function(ext) {
          return onAdd(ext);
        });
        delete queue[type];
      }
      return this;
    },
    /**
     * Handle a type, but using a map by `name` property.
     * @param type - Type of extension to handle.
     * @param map - The object map of named extensions.
     * @returns {PIXI.extensions} For chaining.
     */
    handleByMap: function(type, map2) {
      return this.handle(type, function(extension) {
        map2[extension.name] = extension.ref;
      }, function(extension) {
        delete map2[extension.name];
      });
    },
    /**
     * Handle a type, but using a list of extensions.
     * @param type - Type of extension to handle.
     * @param list - The list of extensions.
     * @returns {PIXI.extensions} For chaining.
     */
    handleByList: function(type, list) {
      return this.handle(type, function(extension) {
        var _a, _b;
        if (list.includes(extension.ref)) {
          return;
        }
        list.push(extension.ref);
        if (type === ExtensionType.Loader) {
          (_b = (_a = extension.ref).add) === null || _b === void 0 ? void 0 : _b.call(_a);
        }
      }, function(extension) {
        var index = list.indexOf(extension.ref);
        if (index !== -1) {
          list.splice(index, 1);
        }
      });
    }
  };

  // node_modules/@pixi/runner/dist/esm/runner.mjs
  var Runner = (
    /** @class */
    (function() {
      function Runner2(name) {
        this.items = [];
        this._name = name;
        this._aliasCount = 0;
      }
      Runner2.prototype.emit = function(a0, a1, a2, a3, a4, a5, a6, a7) {
        if (arguments.length > 8) {
          throw new Error("max arguments reached");
        }
        var _a = this, name = _a.name, items = _a.items;
        this._aliasCount++;
        for (var i = 0, len = items.length; i < len; i++) {
          items[i][name](a0, a1, a2, a3, a4, a5, a6, a7);
        }
        if (items === this.items) {
          this._aliasCount--;
        }
        return this;
      };
      Runner2.prototype.ensureNonAliasedItems = function() {
        if (this._aliasCount > 0 && this.items.length > 1) {
          this._aliasCount = 0;
          this.items = this.items.slice(0);
        }
      };
      Runner2.prototype.add = function(item) {
        if (item[this._name]) {
          this.ensureNonAliasedItems();
          this.remove(item);
          this.items.push(item);
        }
        return this;
      };
      Runner2.prototype.remove = function(item) {
        var index = this.items.indexOf(item);
        if (index !== -1) {
          this.ensureNonAliasedItems();
          this.items.splice(index, 1);
        }
        return this;
      };
      Runner2.prototype.contains = function(item) {
        return this.items.indexOf(item) !== -1;
      };
      Runner2.prototype.removeAll = function() {
        this.ensureNonAliasedItems();
        this.items.length = 0;
        return this;
      };
      Runner2.prototype.destroy = function() {
        this.removeAll();
        this.items = null;
        this._name = null;
      };
      Object.defineProperty(Runner2.prototype, "empty", {
        /**
         * `true` if there are no this Runner contains no listeners
         * @readonly
         */
        get: function() {
          return this.items.length === 0;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(Runner2.prototype, "name", {
        /**
         * The name of the runner.
         * @readonly
         */
        get: function() {
          return this._name;
        },
        enumerable: false,
        configurable: true
      });
      return Runner2;
    })()
  );
  Object.defineProperties(Runner.prototype, {
    /**
     * Alias for `emit`
     * @memberof PIXI.Runner#
     * @method dispatch
     * @see PIXI.Runner#emit
     */
    dispatch: { value: Runner.prototype.emit },
    /**
     * Alias for `emit`
     * @memberof PIXI.Runner#
     * @method run
     * @see PIXI.Runner#emit
     */
    run: { value: Runner.prototype.emit }
  });

  // node_modules/@pixi/ticker/dist/esm/ticker.mjs
  settings.TARGET_FPMS = 0.06;
  var UPDATE_PRIORITY;
  (function(UPDATE_PRIORITY2) {
    UPDATE_PRIORITY2[UPDATE_PRIORITY2["INTERACTION"] = 50] = "INTERACTION";
    UPDATE_PRIORITY2[UPDATE_PRIORITY2["HIGH"] = 25] = "HIGH";
    UPDATE_PRIORITY2[UPDATE_PRIORITY2["NORMAL"] = 0] = "NORMAL";
    UPDATE_PRIORITY2[UPDATE_PRIORITY2["LOW"] = -25] = "LOW";
    UPDATE_PRIORITY2[UPDATE_PRIORITY2["UTILITY"] = -50] = "UTILITY";
  })(UPDATE_PRIORITY || (UPDATE_PRIORITY = {}));
  var TickerListener = (
    /** @class */
    (function() {
      function TickerListener2(fn, context2, priority, once) {
        if (context2 === void 0) {
          context2 = null;
        }
        if (priority === void 0) {
          priority = 0;
        }
        if (once === void 0) {
          once = false;
        }
        this.next = null;
        this.previous = null;
        this._destroyed = false;
        this.fn = fn;
        this.context = context2;
        this.priority = priority;
        this.once = once;
      }
      TickerListener2.prototype.match = function(fn, context2) {
        if (context2 === void 0) {
          context2 = null;
        }
        return this.fn === fn && this.context === context2;
      };
      TickerListener2.prototype.emit = function(deltaTime) {
        if (this.fn) {
          if (this.context) {
            this.fn.call(this.context, deltaTime);
          } else {
            this.fn(deltaTime);
          }
        }
        var redirect = this.next;
        if (this.once) {
          this.destroy(true);
        }
        if (this._destroyed) {
          this.next = null;
        }
        return redirect;
      };
      TickerListener2.prototype.connect = function(previous) {
        this.previous = previous;
        if (previous.next) {
          previous.next.previous = this;
        }
        this.next = previous.next;
        previous.next = this;
      };
      TickerListener2.prototype.destroy = function(hard) {
        if (hard === void 0) {
          hard = false;
        }
        this._destroyed = true;
        this.fn = null;
        this.context = null;
        if (this.previous) {
          this.previous.next = this.next;
        }
        if (this.next) {
          this.next.previous = this.previous;
        }
        var redirect = this.next;
        this.next = hard ? null : redirect;
        this.previous = null;
        return redirect;
      };
      return TickerListener2;
    })()
  );
  var Ticker = (
    /** @class */
    (function() {
      function Ticker2() {
        var _this = this;
        this.autoStart = false;
        this.deltaTime = 1;
        this.lastTime = -1;
        this.speed = 1;
        this.started = false;
        this._requestId = null;
        this._maxElapsedMS = 100;
        this._minElapsedMS = 0;
        this._protected = false;
        this._lastFrame = -1;
        this._head = new TickerListener(null, null, Infinity);
        this.deltaMS = 1 / settings.TARGET_FPMS;
        this.elapsedMS = 1 / settings.TARGET_FPMS;
        this._tick = function(time) {
          _this._requestId = null;
          if (_this.started) {
            _this.update(time);
            if (_this.started && _this._requestId === null && _this._head.next) {
              _this._requestId = requestAnimationFrame(_this._tick);
            }
          }
        };
      }
      Ticker2.prototype._requestIfNeeded = function() {
        if (this._requestId === null && this._head.next) {
          this.lastTime = performance.now();
          this._lastFrame = this.lastTime;
          this._requestId = requestAnimationFrame(this._tick);
        }
      };
      Ticker2.prototype._cancelIfNeeded = function() {
        if (this._requestId !== null) {
          cancelAnimationFrame(this._requestId);
          this._requestId = null;
        }
      };
      Ticker2.prototype._startIfPossible = function() {
        if (this.started) {
          this._requestIfNeeded();
        } else if (this.autoStart) {
          this.start();
        }
      };
      Ticker2.prototype.add = function(fn, context2, priority) {
        if (priority === void 0) {
          priority = UPDATE_PRIORITY.NORMAL;
        }
        return this._addListener(new TickerListener(fn, context2, priority));
      };
      Ticker2.prototype.addOnce = function(fn, context2, priority) {
        if (priority === void 0) {
          priority = UPDATE_PRIORITY.NORMAL;
        }
        return this._addListener(new TickerListener(fn, context2, priority, true));
      };
      Ticker2.prototype._addListener = function(listener) {
        var current = this._head.next;
        var previous = this._head;
        if (!current) {
          listener.connect(previous);
        } else {
          while (current) {
            if (listener.priority > current.priority) {
              listener.connect(previous);
              break;
            }
            previous = current;
            current = current.next;
          }
          if (!listener.previous) {
            listener.connect(previous);
          }
        }
        this._startIfPossible();
        return this;
      };
      Ticker2.prototype.remove = function(fn, context2) {
        var listener = this._head.next;
        while (listener) {
          if (listener.match(fn, context2)) {
            listener = listener.destroy();
          } else {
            listener = listener.next;
          }
        }
        if (!this._head.next) {
          this._cancelIfNeeded();
        }
        return this;
      };
      Object.defineProperty(Ticker2.prototype, "count", {
        /**
         * The number of listeners on this ticker, calculated by walking through linked list
         * @readonly
         * @member {number}
         */
        get: function() {
          if (!this._head) {
            return 0;
          }
          var count = 0;
          var current = this._head;
          while (current = current.next) {
            count++;
          }
          return count;
        },
        enumerable: false,
        configurable: true
      });
      Ticker2.prototype.start = function() {
        if (!this.started) {
          this.started = true;
          this._requestIfNeeded();
        }
      };
      Ticker2.prototype.stop = function() {
        if (this.started) {
          this.started = false;
          this._cancelIfNeeded();
        }
      };
      Ticker2.prototype.destroy = function() {
        if (!this._protected) {
          this.stop();
          var listener = this._head.next;
          while (listener) {
            listener = listener.destroy(true);
          }
          this._head.destroy();
          this._head = null;
        }
      };
      Ticker2.prototype.update = function(currentTime) {
        if (currentTime === void 0) {
          currentTime = performance.now();
        }
        var elapsedMS;
        if (currentTime > this.lastTime) {
          elapsedMS = this.elapsedMS = currentTime - this.lastTime;
          if (elapsedMS > this._maxElapsedMS) {
            elapsedMS = this._maxElapsedMS;
          }
          elapsedMS *= this.speed;
          if (this._minElapsedMS) {
            var delta = currentTime - this._lastFrame | 0;
            if (delta < this._minElapsedMS) {
              return;
            }
            this._lastFrame = currentTime - delta % this._minElapsedMS;
          }
          this.deltaMS = elapsedMS;
          this.deltaTime = this.deltaMS * settings.TARGET_FPMS;
          var head = this._head;
          var listener = head.next;
          while (listener) {
            listener = listener.emit(this.deltaTime);
          }
          if (!head.next) {
            this._cancelIfNeeded();
          }
        } else {
          this.deltaTime = this.deltaMS = this.elapsedMS = 0;
        }
        this.lastTime = currentTime;
      };
      Object.defineProperty(Ticker2.prototype, "FPS", {
        /**
         * The frames per second at which this ticker is running.
         * The default is approximately 60 in most modern browsers.
         * **Note:** This does not factor in the value of
         * {@link PIXI.Ticker#speed}, which is specific
         * to scaling {@link PIXI.Ticker#deltaTime}.
         * @member {number}
         * @readonly
         */
        get: function() {
          return 1e3 / this.elapsedMS;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(Ticker2.prototype, "minFPS", {
        /**
         * Manages the maximum amount of milliseconds allowed to
         * elapse between invoking {@link PIXI.Ticker#update}.
         * This value is used to cap {@link PIXI.Ticker#deltaTime},
         * but does not effect the measured value of {@link PIXI.Ticker#FPS}.
         * When setting this property it is clamped to a value between
         * `0` and `PIXI.settings.TARGET_FPMS * 1000`.
         * @member {number}
         * @default 10
         */
        get: function() {
          return 1e3 / this._maxElapsedMS;
        },
        set: function(fps) {
          var minFPS = Math.min(this.maxFPS, fps);
          var minFPMS = Math.min(Math.max(0, minFPS) / 1e3, settings.TARGET_FPMS);
          this._maxElapsedMS = 1 / minFPMS;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(Ticker2.prototype, "maxFPS", {
        /**
         * Manages the minimum amount of milliseconds required to
         * elapse between invoking {@link PIXI.Ticker#update}.
         * This will effect the measured value of {@link PIXI.Ticker#FPS}.
         * If it is set to `0`, then there is no limit; PixiJS will render as many frames as it can.
         * Otherwise it will be at least `minFPS`
         * @member {number}
         * @default 0
         */
        get: function() {
          if (this._minElapsedMS) {
            return Math.round(1e3 / this._minElapsedMS);
          }
          return 0;
        },
        set: function(fps) {
          if (fps === 0) {
            this._minElapsedMS = 0;
          } else {
            var maxFPS = Math.max(this.minFPS, fps);
            this._minElapsedMS = 1 / (maxFPS / 1e3);
          }
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(Ticker2, "shared", {
        /**
         * The shared ticker instance used by {@link PIXI.AnimatedSprite} and by
         * {@link PIXI.VideoResource} to update animation frames / video textures.
         *
         * It may also be used by {@link PIXI.Application} if created with the `sharedTicker` option property set to true.
         *
         * The property {@link PIXI.Ticker#autoStart} is set to `true` for this instance.
         * Please follow the examples for usage, including how to opt-out of auto-starting the shared ticker.
         * @example
         * let ticker = PIXI.Ticker.shared;
         * // Set this to prevent starting this ticker when listeners are added.
         * // By default this is true only for the PIXI.Ticker.shared instance.
         * ticker.autoStart = false;
         * // FYI, call this to ensure the ticker is stopped. It should be stopped
         * // if you have not attempted to render anything yet.
         * ticker.stop();
         * // Call this when you are ready for a running shared ticker.
         * ticker.start();
         * @example
         * // You may use the shared ticker to render...
         * let renderer = PIXI.autoDetectRenderer();
         * let stage = new PIXI.Container();
         * document.body.appendChild(renderer.view);
         * ticker.add(function (time) {
         *     renderer.render(stage);
         * });
         * @example
         * // Or you can just update it manually.
         * ticker.autoStart = false;
         * ticker.stop();
         * function animate(time) {
         *     ticker.update(time);
         *     renderer.render(stage);
         *     requestAnimationFrame(animate);
         * }
         * animate(performance.now());
         * @member {PIXI.Ticker}
         * @static
         */
        get: function() {
          if (!Ticker2._shared) {
            var shared = Ticker2._shared = new Ticker2();
            shared.autoStart = true;
            shared._protected = true;
          }
          return Ticker2._shared;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(Ticker2, "system", {
        /**
         * The system ticker instance used by {@link PIXI.InteractionManager} and by
         * {@link PIXI.BasePrepare} for core timing functionality that shouldn't usually need to be paused,
         * unlike the `shared` ticker which drives visual animations and rendering which may want to be paused.
         *
         * The property {@link PIXI.Ticker#autoStart} is set to `true` for this instance.
         * @member {PIXI.Ticker}
         * @static
         */
        get: function() {
          if (!Ticker2._system) {
            var system = Ticker2._system = new Ticker2();
            system.autoStart = true;
            system._protected = true;
          }
          return Ticker2._system;
        },
        enumerable: false,
        configurable: true
      });
      return Ticker2;
    })()
  );
  var TickerPlugin = (
    /** @class */
    (function() {
      function TickerPlugin2() {
      }
      TickerPlugin2.init = function(options) {
        var _this = this;
        options = Object.assign({
          autoStart: true,
          sharedTicker: false
        }, options);
        Object.defineProperty(this, "ticker", {
          set: function(ticker) {
            if (this._ticker) {
              this._ticker.remove(this.render, this);
            }
            this._ticker = ticker;
            if (ticker) {
              ticker.add(this.render, this, UPDATE_PRIORITY.LOW);
            }
          },
          get: function() {
            return this._ticker;
          }
        });
        this.stop = function() {
          _this._ticker.stop();
        };
        this.start = function() {
          _this._ticker.start();
        };
        this._ticker = null;
        this.ticker = options.sharedTicker ? Ticker.shared : new Ticker();
        if (options.autoStart) {
          this.start();
        }
      };
      TickerPlugin2.destroy = function() {
        if (this._ticker) {
          var oldTicker = this._ticker;
          this.ticker = null;
          oldTicker.destroy();
        }
      };
      TickerPlugin2.extension = ExtensionType.Application;
      return TickerPlugin2;
    })()
  );

  // node_modules/@pixi/math/dist/esm/math.mjs
  var PI_2 = Math.PI * 2;
  var RAD_TO_DEG = 180 / Math.PI;
  var DEG_TO_RAD = Math.PI / 180;
  var SHAPES;
  (function(SHAPES2) {
    SHAPES2[SHAPES2["POLY"] = 0] = "POLY";
    SHAPES2[SHAPES2["RECT"] = 1] = "RECT";
    SHAPES2[SHAPES2["CIRC"] = 2] = "CIRC";
    SHAPES2[SHAPES2["ELIP"] = 3] = "ELIP";
    SHAPES2[SHAPES2["RREC"] = 4] = "RREC";
  })(SHAPES || (SHAPES = {}));
  var Point = (
    /** @class */
    (function() {
      function Point2(x, y) {
        if (x === void 0) {
          x = 0;
        }
        if (y === void 0) {
          y = 0;
        }
        this.x = 0;
        this.y = 0;
        this.x = x;
        this.y = y;
      }
      Point2.prototype.clone = function() {
        return new Point2(this.x, this.y);
      };
      Point2.prototype.copyFrom = function(p) {
        this.set(p.x, p.y);
        return this;
      };
      Point2.prototype.copyTo = function(p) {
        p.set(this.x, this.y);
        return p;
      };
      Point2.prototype.equals = function(p) {
        return p.x === this.x && p.y === this.y;
      };
      Point2.prototype.set = function(x, y) {
        if (x === void 0) {
          x = 0;
        }
        if (y === void 0) {
          y = x;
        }
        this.x = x;
        this.y = y;
        return this;
      };
      Point2.prototype.toString = function() {
        return "[@pixi/math:Point x=" + this.x + " y=" + this.y + "]";
      };
      return Point2;
    })()
  );
  var tempPoints = [new Point(), new Point(), new Point(), new Point()];
  var Rectangle = (
    /** @class */
    (function() {
      function Rectangle2(x, y, width, height) {
        if (x === void 0) {
          x = 0;
        }
        if (y === void 0) {
          y = 0;
        }
        if (width === void 0) {
          width = 0;
        }
        if (height === void 0) {
          height = 0;
        }
        this.x = Number(x);
        this.y = Number(y);
        this.width = Number(width);
        this.height = Number(height);
        this.type = SHAPES.RECT;
      }
      Object.defineProperty(Rectangle2.prototype, "left", {
        /** Returns the left edge of the rectangle. */
        get: function() {
          return this.x;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(Rectangle2.prototype, "right", {
        /** Returns the right edge of the rectangle. */
        get: function() {
          return this.x + this.width;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(Rectangle2.prototype, "top", {
        /** Returns the top edge of the rectangle. */
        get: function() {
          return this.y;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(Rectangle2.prototype, "bottom", {
        /** Returns the bottom edge of the rectangle. */
        get: function() {
          return this.y + this.height;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(Rectangle2, "EMPTY", {
        /** A constant empty rectangle. */
        get: function() {
          return new Rectangle2(0, 0, 0, 0);
        },
        enumerable: false,
        configurable: true
      });
      Rectangle2.prototype.clone = function() {
        return new Rectangle2(this.x, this.y, this.width, this.height);
      };
      Rectangle2.prototype.copyFrom = function(rectangle) {
        this.x = rectangle.x;
        this.y = rectangle.y;
        this.width = rectangle.width;
        this.height = rectangle.height;
        return this;
      };
      Rectangle2.prototype.copyTo = function(rectangle) {
        rectangle.x = this.x;
        rectangle.y = this.y;
        rectangle.width = this.width;
        rectangle.height = this.height;
        return rectangle;
      };
      Rectangle2.prototype.contains = function(x, y) {
        if (this.width <= 0 || this.height <= 0) {
          return false;
        }
        if (x >= this.x && x < this.x + this.width) {
          if (y >= this.y && y < this.y + this.height) {
            return true;
          }
        }
        return false;
      };
      Rectangle2.prototype.intersects = function(other, transform) {
        if (!transform) {
          var x0_1 = this.x < other.x ? other.x : this.x;
          var x1_1 = this.right > other.right ? other.right : this.right;
          if (x1_1 <= x0_1) {
            return false;
          }
          var y0_1 = this.y < other.y ? other.y : this.y;
          var y1_1 = this.bottom > other.bottom ? other.bottom : this.bottom;
          return y1_1 > y0_1;
        }
        var x0 = this.left;
        var x1 = this.right;
        var y0 = this.top;
        var y1 = this.bottom;
        if (x1 <= x0 || y1 <= y0) {
          return false;
        }
        var lt = tempPoints[0].set(other.left, other.top);
        var lb = tempPoints[1].set(other.left, other.bottom);
        var rt = tempPoints[2].set(other.right, other.top);
        var rb = tempPoints[3].set(other.right, other.bottom);
        if (rt.x <= lt.x || lb.y <= lt.y) {
          return false;
        }
        var s = Math.sign(transform.a * transform.d - transform.b * transform.c);
        if (s === 0) {
          return false;
        }
        transform.apply(lt, lt);
        transform.apply(lb, lb);
        transform.apply(rt, rt);
        transform.apply(rb, rb);
        if (Math.max(lt.x, lb.x, rt.x, rb.x) <= x0 || Math.min(lt.x, lb.x, rt.x, rb.x) >= x1 || Math.max(lt.y, lb.y, rt.y, rb.y) <= y0 || Math.min(lt.y, lb.y, rt.y, rb.y) >= y1) {
          return false;
        }
        var nx = s * (lb.y - lt.y);
        var ny = s * (lt.x - lb.x);
        var n00 = nx * x0 + ny * y0;
        var n10 = nx * x1 + ny * y0;
        var n01 = nx * x0 + ny * y1;
        var n11 = nx * x1 + ny * y1;
        if (Math.max(n00, n10, n01, n11) <= nx * lt.x + ny * lt.y || Math.min(n00, n10, n01, n11) >= nx * rb.x + ny * rb.y) {
          return false;
        }
        var mx = s * (lt.y - rt.y);
        var my = s * (rt.x - lt.x);
        var m00 = mx * x0 + my * y0;
        var m10 = mx * x1 + my * y0;
        var m01 = mx * x0 + my * y1;
        var m11 = mx * x1 + my * y1;
        if (Math.max(m00, m10, m01, m11) <= mx * lt.x + my * lt.y || Math.min(m00, m10, m01, m11) >= mx * rb.x + my * rb.y) {
          return false;
        }
        return true;
      };
      Rectangle2.prototype.pad = function(paddingX, paddingY) {
        if (paddingX === void 0) {
          paddingX = 0;
        }
        if (paddingY === void 0) {
          paddingY = paddingX;
        }
        this.x -= paddingX;
        this.y -= paddingY;
        this.width += paddingX * 2;
        this.height += paddingY * 2;
        return this;
      };
      Rectangle2.prototype.fit = function(rectangle) {
        var x1 = Math.max(this.x, rectangle.x);
        var x2 = Math.min(this.x + this.width, rectangle.x + rectangle.width);
        var y1 = Math.max(this.y, rectangle.y);
        var y2 = Math.min(this.y + this.height, rectangle.y + rectangle.height);
        this.x = x1;
        this.width = Math.max(x2 - x1, 0);
        this.y = y1;
        this.height = Math.max(y2 - y1, 0);
        return this;
      };
      Rectangle2.prototype.ceil = function(resolution, eps) {
        if (resolution === void 0) {
          resolution = 1;
        }
        if (eps === void 0) {
          eps = 1e-3;
        }
        var x2 = Math.ceil((this.x + this.width - eps) * resolution) / resolution;
        var y2 = Math.ceil((this.y + this.height - eps) * resolution) / resolution;
        this.x = Math.floor((this.x + eps) * resolution) / resolution;
        this.y = Math.floor((this.y + eps) * resolution) / resolution;
        this.width = x2 - this.x;
        this.height = y2 - this.y;
        return this;
      };
      Rectangle2.prototype.enlarge = function(rectangle) {
        var x1 = Math.min(this.x, rectangle.x);
        var x2 = Math.max(this.x + this.width, rectangle.x + rectangle.width);
        var y1 = Math.min(this.y, rectangle.y);
        var y2 = Math.max(this.y + this.height, rectangle.y + rectangle.height);
        this.x = x1;
        this.width = x2 - x1;
        this.y = y1;
        this.height = y2 - y1;
        return this;
      };
      Rectangle2.prototype.toString = function() {
        return "[@pixi/math:Rectangle x=" + this.x + " y=" + this.y + " width=" + this.width + " height=" + this.height + "]";
      };
      return Rectangle2;
    })()
  );
  var Circle = (
    /** @class */
    (function() {
      function Circle2(x, y, radius) {
        if (x === void 0) {
          x = 0;
        }
        if (y === void 0) {
          y = 0;
        }
        if (radius === void 0) {
          radius = 0;
        }
        this.x = x;
        this.y = y;
        this.radius = radius;
        this.type = SHAPES.CIRC;
      }
      Circle2.prototype.clone = function() {
        return new Circle2(this.x, this.y, this.radius);
      };
      Circle2.prototype.contains = function(x, y) {
        if (this.radius <= 0) {
          return false;
        }
        var r2 = this.radius * this.radius;
        var dx = this.x - x;
        var dy = this.y - y;
        dx *= dx;
        dy *= dy;
        return dx + dy <= r2;
      };
      Circle2.prototype.getBounds = function() {
        return new Rectangle(this.x - this.radius, this.y - this.radius, this.radius * 2, this.radius * 2);
      };
      Circle2.prototype.toString = function() {
        return "[@pixi/math:Circle x=" + this.x + " y=" + this.y + " radius=" + this.radius + "]";
      };
      return Circle2;
    })()
  );
  var Ellipse = (
    /** @class */
    (function() {
      function Ellipse2(x, y, halfWidth, halfHeight) {
        if (x === void 0) {
          x = 0;
        }
        if (y === void 0) {
          y = 0;
        }
        if (halfWidth === void 0) {
          halfWidth = 0;
        }
        if (halfHeight === void 0) {
          halfHeight = 0;
        }
        this.x = x;
        this.y = y;
        this.width = halfWidth;
        this.height = halfHeight;
        this.type = SHAPES.ELIP;
      }
      Ellipse2.prototype.clone = function() {
        return new Ellipse2(this.x, this.y, this.width, this.height);
      };
      Ellipse2.prototype.contains = function(x, y) {
        if (this.width <= 0 || this.height <= 0) {
          return false;
        }
        var normx = (x - this.x) / this.width;
        var normy = (y - this.y) / this.height;
        normx *= normx;
        normy *= normy;
        return normx + normy <= 1;
      };
      Ellipse2.prototype.getBounds = function() {
        return new Rectangle(this.x - this.width, this.y - this.height, this.width, this.height);
      };
      Ellipse2.prototype.toString = function() {
        return "[@pixi/math:Ellipse x=" + this.x + " y=" + this.y + " width=" + this.width + " height=" + this.height + "]";
      };
      return Ellipse2;
    })()
  );
  var Polygon = (
    /** @class */
    (function() {
      function Polygon2() {
        var arguments$1 = arguments;
        var points = [];
        for (var _i = 0; _i < arguments.length; _i++) {
          points[_i] = arguments$1[_i];
        }
        var flat = Array.isArray(points[0]) ? points[0] : points;
        if (typeof flat[0] !== "number") {
          var p = [];
          for (var i = 0, il = flat.length; i < il; i++) {
            p.push(flat[i].x, flat[i].y);
          }
          flat = p;
        }
        this.points = flat;
        this.type = SHAPES.POLY;
        this.closeStroke = true;
      }
      Polygon2.prototype.clone = function() {
        var points = this.points.slice();
        var polygon = new Polygon2(points);
        polygon.closeStroke = this.closeStroke;
        return polygon;
      };
      Polygon2.prototype.contains = function(x, y) {
        var inside = false;
        var length = this.points.length / 2;
        for (var i = 0, j = length - 1; i < length; j = i++) {
          var xi = this.points[i * 2];
          var yi = this.points[i * 2 + 1];
          var xj = this.points[j * 2];
          var yj = this.points[j * 2 + 1];
          var intersect = yi > y !== yj > y && x < (xj - xi) * ((y - yi) / (yj - yi)) + xi;
          if (intersect) {
            inside = !inside;
          }
        }
        return inside;
      };
      Polygon2.prototype.toString = function() {
        return "[@pixi/math:Polygon" + ("closeStroke=" + this.closeStroke) + ("points=" + this.points.reduce(function(pointsDesc, currentPoint) {
          return pointsDesc + ", " + currentPoint;
        }, "") + "]");
      };
      return Polygon2;
    })()
  );
  var RoundedRectangle = (
    /** @class */
    (function() {
      function RoundedRectangle2(x, y, width, height, radius) {
        if (x === void 0) {
          x = 0;
        }
        if (y === void 0) {
          y = 0;
        }
        if (width === void 0) {
          width = 0;
        }
        if (height === void 0) {
          height = 0;
        }
        if (radius === void 0) {
          radius = 20;
        }
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
        this.radius = radius;
        this.type = SHAPES.RREC;
      }
      RoundedRectangle2.prototype.clone = function() {
        return new RoundedRectangle2(this.x, this.y, this.width, this.height, this.radius);
      };
      RoundedRectangle2.prototype.contains = function(x, y) {
        if (this.width <= 0 || this.height <= 0) {
          return false;
        }
        if (x >= this.x && x <= this.x + this.width) {
          if (y >= this.y && y <= this.y + this.height) {
            var radius = Math.max(0, Math.min(this.radius, Math.min(this.width, this.height) / 2));
            if (y >= this.y + radius && y <= this.y + this.height - radius || x >= this.x + radius && x <= this.x + this.width - radius) {
              return true;
            }
            var dx = x - (this.x + radius);
            var dy = y - (this.y + radius);
            var radius2 = radius * radius;
            if (dx * dx + dy * dy <= radius2) {
              return true;
            }
            dx = x - (this.x + this.width - radius);
            if (dx * dx + dy * dy <= radius2) {
              return true;
            }
            dy = y - (this.y + this.height - radius);
            if (dx * dx + dy * dy <= radius2) {
              return true;
            }
            dx = x - (this.x + radius);
            if (dx * dx + dy * dy <= radius2) {
              return true;
            }
          }
        }
        return false;
      };
      RoundedRectangle2.prototype.toString = function() {
        return "[@pixi/math:RoundedRectangle x=" + this.x + " y=" + this.y + ("width=" + this.width + " height=" + this.height + " radius=" + this.radius + "]");
      };
      return RoundedRectangle2;
    })()
  );
  var ObservablePoint = (
    /** @class */
    (function() {
      function ObservablePoint2(cb, scope, x, y) {
        if (x === void 0) {
          x = 0;
        }
        if (y === void 0) {
          y = 0;
        }
        this._x = x;
        this._y = y;
        this.cb = cb;
        this.scope = scope;
      }
      ObservablePoint2.prototype.clone = function(cb, scope) {
        if (cb === void 0) {
          cb = this.cb;
        }
        if (scope === void 0) {
          scope = this.scope;
        }
        return new ObservablePoint2(cb, scope, this._x, this._y);
      };
      ObservablePoint2.prototype.set = function(x, y) {
        if (x === void 0) {
          x = 0;
        }
        if (y === void 0) {
          y = x;
        }
        if (this._x !== x || this._y !== y) {
          this._x = x;
          this._y = y;
          this.cb.call(this.scope);
        }
        return this;
      };
      ObservablePoint2.prototype.copyFrom = function(p) {
        if (this._x !== p.x || this._y !== p.y) {
          this._x = p.x;
          this._y = p.y;
          this.cb.call(this.scope);
        }
        return this;
      };
      ObservablePoint2.prototype.copyTo = function(p) {
        p.set(this._x, this._y);
        return p;
      };
      ObservablePoint2.prototype.equals = function(p) {
        return p.x === this._x && p.y === this._y;
      };
      ObservablePoint2.prototype.toString = function() {
        return "[@pixi/math:ObservablePoint x=0 y=0 scope=" + this.scope + "]";
      };
      Object.defineProperty(ObservablePoint2.prototype, "x", {
        /** Position of the observable point on the x axis. */
        get: function() {
          return this._x;
        },
        set: function(value) {
          if (this._x !== value) {
            this._x = value;
            this.cb.call(this.scope);
          }
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(ObservablePoint2.prototype, "y", {
        /** Position of the observable point on the y axis. */
        get: function() {
          return this._y;
        },
        set: function(value) {
          if (this._y !== value) {
            this._y = value;
            this.cb.call(this.scope);
          }
        },
        enumerable: false,
        configurable: true
      });
      return ObservablePoint2;
    })()
  );
  var Matrix = (
    /** @class */
    (function() {
      function Matrix2(a, b, c, d, tx, ty) {
        if (a === void 0) {
          a = 1;
        }
        if (b === void 0) {
          b = 0;
        }
        if (c === void 0) {
          c = 0;
        }
        if (d === void 0) {
          d = 1;
        }
        if (tx === void 0) {
          tx = 0;
        }
        if (ty === void 0) {
          ty = 0;
        }
        this.array = null;
        this.a = a;
        this.b = b;
        this.c = c;
        this.d = d;
        this.tx = tx;
        this.ty = ty;
      }
      Matrix2.prototype.fromArray = function(array) {
        this.a = array[0];
        this.b = array[1];
        this.c = array[3];
        this.d = array[4];
        this.tx = array[2];
        this.ty = array[5];
      };
      Matrix2.prototype.set = function(a, b, c, d, tx, ty) {
        this.a = a;
        this.b = b;
        this.c = c;
        this.d = d;
        this.tx = tx;
        this.ty = ty;
        return this;
      };
      Matrix2.prototype.toArray = function(transpose, out) {
        if (!this.array) {
          this.array = new Float32Array(9);
        }
        var array = out || this.array;
        if (transpose) {
          array[0] = this.a;
          array[1] = this.b;
          array[2] = 0;
          array[3] = this.c;
          array[4] = this.d;
          array[5] = 0;
          array[6] = this.tx;
          array[7] = this.ty;
          array[8] = 1;
        } else {
          array[0] = this.a;
          array[1] = this.c;
          array[2] = this.tx;
          array[3] = this.b;
          array[4] = this.d;
          array[5] = this.ty;
          array[6] = 0;
          array[7] = 0;
          array[8] = 1;
        }
        return array;
      };
      Matrix2.prototype.apply = function(pos, newPos) {
        newPos = newPos || new Point();
        var x = pos.x;
        var y = pos.y;
        newPos.x = this.a * x + this.c * y + this.tx;
        newPos.y = this.b * x + this.d * y + this.ty;
        return newPos;
      };
      Matrix2.prototype.applyInverse = function(pos, newPos) {
        newPos = newPos || new Point();
        var id = 1 / (this.a * this.d + this.c * -this.b);
        var x = pos.x;
        var y = pos.y;
        newPos.x = this.d * id * x + -this.c * id * y + (this.ty * this.c - this.tx * this.d) * id;
        newPos.y = this.a * id * y + -this.b * id * x + (-this.ty * this.a + this.tx * this.b) * id;
        return newPos;
      };
      Matrix2.prototype.translate = function(x, y) {
        this.tx += x;
        this.ty += y;
        return this;
      };
      Matrix2.prototype.scale = function(x, y) {
        this.a *= x;
        this.d *= y;
        this.c *= x;
        this.b *= y;
        this.tx *= x;
        this.ty *= y;
        return this;
      };
      Matrix2.prototype.rotate = function(angle) {
        var cos = Math.cos(angle);
        var sin = Math.sin(angle);
        var a1 = this.a;
        var c1 = this.c;
        var tx1 = this.tx;
        this.a = a1 * cos - this.b * sin;
        this.b = a1 * sin + this.b * cos;
        this.c = c1 * cos - this.d * sin;
        this.d = c1 * sin + this.d * cos;
        this.tx = tx1 * cos - this.ty * sin;
        this.ty = tx1 * sin + this.ty * cos;
        return this;
      };
      Matrix2.prototype.append = function(matrix) {
        var a1 = this.a;
        var b1 = this.b;
        var c1 = this.c;
        var d1 = this.d;
        this.a = matrix.a * a1 + matrix.b * c1;
        this.b = matrix.a * b1 + matrix.b * d1;
        this.c = matrix.c * a1 + matrix.d * c1;
        this.d = matrix.c * b1 + matrix.d * d1;
        this.tx = matrix.tx * a1 + matrix.ty * c1 + this.tx;
        this.ty = matrix.tx * b1 + matrix.ty * d1 + this.ty;
        return this;
      };
      Matrix2.prototype.setTransform = function(x, y, pivotX, pivotY, scaleX, scaleY, rotation, skewX, skewY) {
        this.a = Math.cos(rotation + skewY) * scaleX;
        this.b = Math.sin(rotation + skewY) * scaleX;
        this.c = -Math.sin(rotation - skewX) * scaleY;
        this.d = Math.cos(rotation - skewX) * scaleY;
        this.tx = x - (pivotX * this.a + pivotY * this.c);
        this.ty = y - (pivotX * this.b + pivotY * this.d);
        return this;
      };
      Matrix2.prototype.prepend = function(matrix) {
        var tx1 = this.tx;
        if (matrix.a !== 1 || matrix.b !== 0 || matrix.c !== 0 || matrix.d !== 1) {
          var a1 = this.a;
          var c1 = this.c;
          this.a = a1 * matrix.a + this.b * matrix.c;
          this.b = a1 * matrix.b + this.b * matrix.d;
          this.c = c1 * matrix.a + this.d * matrix.c;
          this.d = c1 * matrix.b + this.d * matrix.d;
        }
        this.tx = tx1 * matrix.a + this.ty * matrix.c + matrix.tx;
        this.ty = tx1 * matrix.b + this.ty * matrix.d + matrix.ty;
        return this;
      };
      Matrix2.prototype.decompose = function(transform) {
        var a = this.a;
        var b = this.b;
        var c = this.c;
        var d = this.d;
        var pivot = transform.pivot;
        var skewX = -Math.atan2(-c, d);
        var skewY = Math.atan2(b, a);
        var delta = Math.abs(skewX + skewY);
        if (delta < 1e-5 || Math.abs(PI_2 - delta) < 1e-5) {
          transform.rotation = skewY;
          transform.skew.x = transform.skew.y = 0;
        } else {
          transform.rotation = 0;
          transform.skew.x = skewX;
          transform.skew.y = skewY;
        }
        transform.scale.x = Math.sqrt(a * a + b * b);
        transform.scale.y = Math.sqrt(c * c + d * d);
        transform.position.x = this.tx + (pivot.x * a + pivot.y * c);
        transform.position.y = this.ty + (pivot.x * b + pivot.y * d);
        return transform;
      };
      Matrix2.prototype.invert = function() {
        var a1 = this.a;
        var b1 = this.b;
        var c1 = this.c;
        var d1 = this.d;
        var tx1 = this.tx;
        var n = a1 * d1 - b1 * c1;
        this.a = d1 / n;
        this.b = -b1 / n;
        this.c = -c1 / n;
        this.d = a1 / n;
        this.tx = (c1 * this.ty - d1 * tx1) / n;
        this.ty = -(a1 * this.ty - b1 * tx1) / n;
        return this;
      };
      Matrix2.prototype.identity = function() {
        this.a = 1;
        this.b = 0;
        this.c = 0;
        this.d = 1;
        this.tx = 0;
        this.ty = 0;
        return this;
      };
      Matrix2.prototype.clone = function() {
        var matrix = new Matrix2();
        matrix.a = this.a;
        matrix.b = this.b;
        matrix.c = this.c;
        matrix.d = this.d;
        matrix.tx = this.tx;
        matrix.ty = this.ty;
        return matrix;
      };
      Matrix2.prototype.copyTo = function(matrix) {
        matrix.a = this.a;
        matrix.b = this.b;
        matrix.c = this.c;
        matrix.d = this.d;
        matrix.tx = this.tx;
        matrix.ty = this.ty;
        return matrix;
      };
      Matrix2.prototype.copyFrom = function(matrix) {
        this.a = matrix.a;
        this.b = matrix.b;
        this.c = matrix.c;
        this.d = matrix.d;
        this.tx = matrix.tx;
        this.ty = matrix.ty;
        return this;
      };
      Matrix2.prototype.toString = function() {
        return "[@pixi/math:Matrix a=" + this.a + " b=" + this.b + " c=" + this.c + " d=" + this.d + " tx=" + this.tx + " ty=" + this.ty + "]";
      };
      Object.defineProperty(Matrix2, "IDENTITY", {
        /**
         * A default (identity) matrix
         * @readonly
         */
        get: function() {
          return new Matrix2();
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(Matrix2, "TEMP_MATRIX", {
        /**
         * A temp matrix
         * @readonly
         */
        get: function() {
          return new Matrix2();
        },
        enumerable: false,
        configurable: true
      });
      return Matrix2;
    })()
  );
  var ux = [1, 1, 0, -1, -1, -1, 0, 1, 1, 1, 0, -1, -1, -1, 0, 1];
  var uy = [0, 1, 1, 1, 0, -1, -1, -1, 0, 1, 1, 1, 0, -1, -1, -1];
  var vx = [0, -1, -1, -1, 0, 1, 1, 1, 0, 1, 1, 1, 0, -1, -1, -1];
  var vy = [1, 1, 0, -1, -1, -1, 0, 1, -1, -1, 0, 1, 1, 1, 0, -1];
  var rotationCayley = [];
  var rotationMatrices = [];
  var signum = Math.sign;
  function init() {
    for (var i = 0; i < 16; i++) {
      var row = [];
      rotationCayley.push(row);
      for (var j = 0; j < 16; j++) {
        var _ux = signum(ux[i] * ux[j] + vx[i] * uy[j]);
        var _uy = signum(uy[i] * ux[j] + vy[i] * uy[j]);
        var _vx = signum(ux[i] * vx[j] + vx[i] * vy[j]);
        var _vy = signum(uy[i] * vx[j] + vy[i] * vy[j]);
        for (var k = 0; k < 16; k++) {
          if (ux[k] === _ux && uy[k] === _uy && vx[k] === _vx && vy[k] === _vy) {
            row.push(k);
            break;
          }
        }
      }
    }
    for (var i = 0; i < 16; i++) {
      var mat = new Matrix();
      mat.set(ux[i], uy[i], vx[i], vy[i], 0, 0);
      rotationMatrices.push(mat);
    }
  }
  init();
  var groupD8 = {
    /**
     * | Rotation | Direction |
     * |----------|-----------|
     * | 0°       | East      |
     * @memberof PIXI.groupD8
     * @constant {PIXI.GD8Symmetry}
     */
    E: 0,
    /**
     * | Rotation | Direction |
     * |----------|-----------|
     * | 45°↻     | Southeast |
     * @memberof PIXI.groupD8
     * @constant {PIXI.GD8Symmetry}
     */
    SE: 1,
    /**
     * | Rotation | Direction |
     * |----------|-----------|
     * | 90°↻     | South     |
     * @memberof PIXI.groupD8
     * @constant {PIXI.GD8Symmetry}
     */
    S: 2,
    /**
     * | Rotation | Direction |
     * |----------|-----------|
     * | 135°↻    | Southwest |
     * @memberof PIXI.groupD8
     * @constant {PIXI.GD8Symmetry}
     */
    SW: 3,
    /**
     * | Rotation | Direction |
     * |----------|-----------|
     * | 180°     | West      |
     * @memberof PIXI.groupD8
     * @constant {PIXI.GD8Symmetry}
     */
    W: 4,
    /**
     * | Rotation    | Direction    |
     * |-------------|--------------|
     * | -135°/225°↻ | Northwest    |
     * @memberof PIXI.groupD8
     * @constant {PIXI.GD8Symmetry}
     */
    NW: 5,
    /**
     * | Rotation    | Direction    |
     * |-------------|--------------|
     * | -90°/270°↻  | North        |
     * @memberof PIXI.groupD8
     * @constant {PIXI.GD8Symmetry}
     */
    N: 6,
    /**
     * | Rotation    | Direction    |
     * |-------------|--------------|
     * | -45°/315°↻  | Northeast    |
     * @memberof PIXI.groupD8
     * @constant {PIXI.GD8Symmetry}
     */
    NE: 7,
    /**
     * Reflection about Y-axis.
     * @memberof PIXI.groupD8
     * @constant {PIXI.GD8Symmetry}
     */
    MIRROR_VERTICAL: 8,
    /**
     * Reflection about the main diagonal.
     * @memberof PIXI.groupD8
     * @constant {PIXI.GD8Symmetry}
     */
    MAIN_DIAGONAL: 10,
    /**
     * Reflection about X-axis.
     * @memberof PIXI.groupD8
     * @constant {PIXI.GD8Symmetry}
     */
    MIRROR_HORIZONTAL: 12,
    /**
     * Reflection about reverse diagonal.
     * @memberof PIXI.groupD8
     * @constant {PIXI.GD8Symmetry}
     */
    REVERSE_DIAGONAL: 14,
    /**
     * @memberof PIXI.groupD8
     * @param {PIXI.GD8Symmetry} ind - sprite rotation angle.
     * @returns {PIXI.GD8Symmetry} The X-component of the U-axis
     *    after rotating the axes.
     */
    uX: function(ind) {
      return ux[ind];
    },
    /**
     * @memberof PIXI.groupD8
     * @param {PIXI.GD8Symmetry} ind - sprite rotation angle.
     * @returns {PIXI.GD8Symmetry} The Y-component of the U-axis
     *    after rotating the axes.
     */
    uY: function(ind) {
      return uy[ind];
    },
    /**
     * @memberof PIXI.groupD8
     * @param {PIXI.GD8Symmetry} ind - sprite rotation angle.
     * @returns {PIXI.GD8Symmetry} The X-component of the V-axis
     *    after rotating the axes.
     */
    vX: function(ind) {
      return vx[ind];
    },
    /**
     * @memberof PIXI.groupD8
     * @param {PIXI.GD8Symmetry} ind - sprite rotation angle.
     * @returns {PIXI.GD8Symmetry} The Y-component of the V-axis
     *    after rotating the axes.
     */
    vY: function(ind) {
      return vy[ind];
    },
    /**
     * @memberof PIXI.groupD8
     * @param {PIXI.GD8Symmetry} rotation - symmetry whose opposite
     *   is needed. Only rotations have opposite symmetries while
     *   reflections don't.
     * @returns {PIXI.GD8Symmetry} The opposite symmetry of `rotation`
     */
    inv: function(rotation) {
      if (rotation & 8) {
        return rotation & 15;
      }
      return -rotation & 7;
    },
    /**
     * Composes the two D8 operations.
     *
     * Taking `^` as reflection:
     *
     * |       | E=0 | S=2 | W=4 | N=6 | E^=8 | S^=10 | W^=12 | N^=14 |
     * |-------|-----|-----|-----|-----|------|-------|-------|-------|
     * | E=0   | E   | S   | W   | N   | E^   | S^    | W^    | N^    |
     * | S=2   | S   | W   | N   | E   | S^   | W^    | N^    | E^    |
     * | W=4   | W   | N   | E   | S   | W^   | N^    | E^    | S^    |
     * | N=6   | N   | E   | S   | W   | N^   | E^    | S^    | W^    |
     * | E^=8  | E^  | N^  | W^  | S^  | E    | N     | W     | S     |
     * | S^=10 | S^  | E^  | N^  | W^  | S    | E     | N     | W     |
     * | W^=12 | W^  | S^  | E^  | N^  | W    | S     | E     | N     |
     * | N^=14 | N^  | W^  | S^  | E^  | N    | W     | S     | E     |
     *
     * [This is a Cayley table]{@link https://en.wikipedia.org/wiki/Cayley_table}
     * @memberof PIXI.groupD8
     * @param {PIXI.GD8Symmetry} rotationSecond - Second operation, which
     *   is the row in the above cayley table.
     * @param {PIXI.GD8Symmetry} rotationFirst - First operation, which
     *   is the column in the above cayley table.
     * @returns {PIXI.GD8Symmetry} Composed operation
     */
    add: function(rotationSecond, rotationFirst) {
      return rotationCayley[rotationSecond][rotationFirst];
    },
    /**
     * Reverse of `add`.
     * @memberof PIXI.groupD8
     * @param {PIXI.GD8Symmetry} rotationSecond - Second operation
     * @param {PIXI.GD8Symmetry} rotationFirst - First operation
     * @returns {PIXI.GD8Symmetry} Result
     */
    sub: function(rotationSecond, rotationFirst) {
      return rotationCayley[rotationSecond][groupD8.inv(rotationFirst)];
    },
    /**
     * Adds 180 degrees to rotation, which is a commutative
     * operation.
     * @memberof PIXI.groupD8
     * @param {number} rotation - The number to rotate.
     * @returns {number} Rotated number
     */
    rotate180: function(rotation) {
      return rotation ^ 4;
    },
    /**
     * Checks if the rotation angle is vertical, i.e. south
     * or north. It doesn't work for reflections.
     * @memberof PIXI.groupD8
     * @param {PIXI.GD8Symmetry} rotation - The number to check.
     * @returns {boolean} Whether or not the direction is vertical
     */
    isVertical: function(rotation) {
      return (rotation & 3) === 2;
    },
    /**
     * Approximates the vector `V(dx,dy)` into one of the
     * eight directions provided by `groupD8`.
     * @memberof PIXI.groupD8
     * @param {number} dx - X-component of the vector
     * @param {number} dy - Y-component of the vector
     * @returns {PIXI.GD8Symmetry} Approximation of the vector into
     *  one of the eight symmetries.
     */
    byDirection: function(dx, dy) {
      if (Math.abs(dx) * 2 <= Math.abs(dy)) {
        if (dy >= 0) {
          return groupD8.S;
        }
        return groupD8.N;
      } else if (Math.abs(dy) * 2 <= Math.abs(dx)) {
        if (dx > 0) {
          return groupD8.E;
        }
        return groupD8.W;
      } else if (dy > 0) {
        if (dx > 0) {
          return groupD8.SE;
        }
        return groupD8.SW;
      } else if (dx > 0) {
        return groupD8.NE;
      }
      return groupD8.NW;
    },
    /**
     * Helps sprite to compensate texture packer rotation.
     * @memberof PIXI.groupD8
     * @param {PIXI.Matrix} matrix - sprite world matrix
     * @param {PIXI.GD8Symmetry} rotation - The rotation factor to use.
     * @param {number} tx - sprite anchoring
     * @param {number} ty - sprite anchoring
     */
    matrixAppendRotationInv: function(matrix, rotation, tx, ty) {
      if (tx === void 0) {
        tx = 0;
      }
      if (ty === void 0) {
        ty = 0;
      }
      var mat = rotationMatrices[groupD8.inv(rotation)];
      mat.tx = tx;
      mat.ty = ty;
      matrix.append(mat);
    }
  };
  var Transform = (
    /** @class */
    (function() {
      function Transform2() {
        this.worldTransform = new Matrix();
        this.localTransform = new Matrix();
        this.position = new ObservablePoint(this.onChange, this, 0, 0);
        this.scale = new ObservablePoint(this.onChange, this, 1, 1);
        this.pivot = new ObservablePoint(this.onChange, this, 0, 0);
        this.skew = new ObservablePoint(this.updateSkew, this, 0, 0);
        this._rotation = 0;
        this._cx = 1;
        this._sx = 0;
        this._cy = 0;
        this._sy = 1;
        this._localID = 0;
        this._currentLocalID = 0;
        this._worldID = 0;
        this._parentID = 0;
      }
      Transform2.prototype.onChange = function() {
        this._localID++;
      };
      Transform2.prototype.updateSkew = function() {
        this._cx = Math.cos(this._rotation + this.skew.y);
        this._sx = Math.sin(this._rotation + this.skew.y);
        this._cy = -Math.sin(this._rotation - this.skew.x);
        this._sy = Math.cos(this._rotation - this.skew.x);
        this._localID++;
      };
      Transform2.prototype.toString = function() {
        return "[@pixi/math:Transform " + ("position=(" + this.position.x + ", " + this.position.y + ") ") + ("rotation=" + this.rotation + " ") + ("scale=(" + this.scale.x + ", " + this.scale.y + ") ") + ("skew=(" + this.skew.x + ", " + this.skew.y + ") ") + "]";
      };
      Transform2.prototype.updateLocalTransform = function() {
        var lt = this.localTransform;
        if (this._localID !== this._currentLocalID) {
          lt.a = this._cx * this.scale.x;
          lt.b = this._sx * this.scale.x;
          lt.c = this._cy * this.scale.y;
          lt.d = this._sy * this.scale.y;
          lt.tx = this.position.x - (this.pivot.x * lt.a + this.pivot.y * lt.c);
          lt.ty = this.position.y - (this.pivot.x * lt.b + this.pivot.y * lt.d);
          this._currentLocalID = this._localID;
          this._parentID = -1;
        }
      };
      Transform2.prototype.updateTransform = function(parentTransform) {
        var lt = this.localTransform;
        if (this._localID !== this._currentLocalID) {
          lt.a = this._cx * this.scale.x;
          lt.b = this._sx * this.scale.x;
          lt.c = this._cy * this.scale.y;
          lt.d = this._sy * this.scale.y;
          lt.tx = this.position.x - (this.pivot.x * lt.a + this.pivot.y * lt.c);
          lt.ty = this.position.y - (this.pivot.x * lt.b + this.pivot.y * lt.d);
          this._currentLocalID = this._localID;
          this._parentID = -1;
        }
        if (this._parentID !== parentTransform._worldID) {
          var pt = parentTransform.worldTransform;
          var wt = this.worldTransform;
          wt.a = lt.a * pt.a + lt.b * pt.c;
          wt.b = lt.a * pt.b + lt.b * pt.d;
          wt.c = lt.c * pt.a + lt.d * pt.c;
          wt.d = lt.c * pt.b + lt.d * pt.d;
          wt.tx = lt.tx * pt.a + lt.ty * pt.c + pt.tx;
          wt.ty = lt.tx * pt.b + lt.ty * pt.d + pt.ty;
          this._parentID = parentTransform._worldID;
          this._worldID++;
        }
      };
      Transform2.prototype.setFromMatrix = function(matrix) {
        matrix.decompose(this);
        this._localID++;
      };
      Object.defineProperty(Transform2.prototype, "rotation", {
        /** The rotation of the object in radians. */
        get: function() {
          return this._rotation;
        },
        set: function(value) {
          if (this._rotation !== value) {
            this._rotation = value;
            this.updateSkew();
          }
        },
        enumerable: false,
        configurable: true
      });
      Transform2.IDENTITY = new Transform2();
      return Transform2;
    })()
  );

  // node_modules/@pixi/core/dist/esm/core.mjs
  settings.PREFER_ENV = isMobile.any ? ENV.WEBGL : ENV.WEBGL2;
  settings.STRICT_TEXTURE_CACHE = false;
  var INSTALLED = [];
  function autoDetectResource(source, options) {
    if (!source) {
      return null;
    }
    var extension = "";
    if (typeof source === "string") {
      var result = /\.(\w{3,4})(?:$|\?|#)/i.exec(source);
      if (result) {
        extension = result[1].toLowerCase();
      }
    }
    for (var i = INSTALLED.length - 1; i >= 0; --i) {
      var ResourcePlugin = INSTALLED[i];
      if (ResourcePlugin.test && ResourcePlugin.test(source, extension)) {
        return new ResourcePlugin(source, options);
      }
    }
    throw new Error("Unrecognized source type to auto-detect Resource");
  }
  var extendStatics = function(d, b) {
    extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d2, b2) {
      d2.__proto__ = b2;
    } || function(d2, b2) {
      for (var p in b2) {
        if (b2.hasOwnProperty(p)) {
          d2[p] = b2[p];
        }
      }
    };
    return extendStatics(d, b);
  };
  function __extends(d, b) {
    extendStatics(d, b);
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  }
  var __assign2 = function() {
    __assign2 = Object.assign || function __assign3(t) {
      var arguments$1 = arguments;
      for (var s, i = 1, n = arguments.length; i < n; i++) {
        s = arguments$1[i];
        for (var p in s) {
          if (Object.prototype.hasOwnProperty.call(s, p)) {
            t[p] = s[p];
          }
        }
      }
      return t;
    };
    return __assign2.apply(this, arguments);
  };
  function __rest(s, e) {
    var t = {};
    for (var p in s) {
      if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0) {
        t[p] = s[p];
      }
    }
    if (s != null && typeof Object.getOwnPropertySymbols === "function") {
      for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
        if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i])) {
          t[p[i]] = s[p[i]];
        }
      }
    }
    return t;
  }
  var Resource = (
    /** @class */
    (function() {
      function Resource2(width, height) {
        if (width === void 0) {
          width = 0;
        }
        if (height === void 0) {
          height = 0;
        }
        this._width = width;
        this._height = height;
        this.destroyed = false;
        this.internal = false;
        this.onResize = new Runner("setRealSize");
        this.onUpdate = new Runner("update");
        this.onError = new Runner("onError");
      }
      Resource2.prototype.bind = function(baseTexture) {
        this.onResize.add(baseTexture);
        this.onUpdate.add(baseTexture);
        this.onError.add(baseTexture);
        if (this._width || this._height) {
          this.onResize.emit(this._width, this._height);
        }
      };
      Resource2.prototype.unbind = function(baseTexture) {
        this.onResize.remove(baseTexture);
        this.onUpdate.remove(baseTexture);
        this.onError.remove(baseTexture);
      };
      Resource2.prototype.resize = function(width, height) {
        if (width !== this._width || height !== this._height) {
          this._width = width;
          this._height = height;
          this.onResize.emit(width, height);
        }
      };
      Object.defineProperty(Resource2.prototype, "valid", {
        /**
         * Has been validated
         * @readonly
         */
        get: function() {
          return !!this._width && !!this._height;
        },
        enumerable: false,
        configurable: true
      });
      Resource2.prototype.update = function() {
        if (!this.destroyed) {
          this.onUpdate.emit();
        }
      };
      Resource2.prototype.load = function() {
        return Promise.resolve(this);
      };
      Object.defineProperty(Resource2.prototype, "width", {
        /**
         * The width of the resource.
         * @readonly
         */
        get: function() {
          return this._width;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(Resource2.prototype, "height", {
        /**
         * The height of the resource.
         * @readonly
         */
        get: function() {
          return this._height;
        },
        enumerable: false,
        configurable: true
      });
      Resource2.prototype.style = function(_renderer, _baseTexture, _glTexture) {
        return false;
      };
      Resource2.prototype.dispose = function() {
      };
      Resource2.prototype.destroy = function() {
        if (!this.destroyed) {
          this.destroyed = true;
          this.dispose();
          this.onError.removeAll();
          this.onError = null;
          this.onResize.removeAll();
          this.onResize = null;
          this.onUpdate.removeAll();
          this.onUpdate = null;
        }
      };
      Resource2.test = function(_source, _extension) {
        return false;
      };
      return Resource2;
    })()
  );
  var BufferResource = (
    /** @class */
    (function(_super) {
      __extends(BufferResource2, _super);
      function BufferResource2(source, options) {
        var _this = this;
        var _a = options || {}, width = _a.width, height = _a.height;
        if (!width || !height) {
          throw new Error("BufferResource width or height invalid");
        }
        _this = _super.call(this, width, height) || this;
        _this.data = source;
        return _this;
      }
      BufferResource2.prototype.upload = function(renderer, baseTexture, glTexture) {
        var gl = renderer.gl;
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, baseTexture.alphaMode === ALPHA_MODES.UNPACK);
        var width = baseTexture.realWidth;
        var height = baseTexture.realHeight;
        if (glTexture.width === width && glTexture.height === height) {
          gl.texSubImage2D(baseTexture.target, 0, 0, 0, width, height, baseTexture.format, glTexture.type, this.data);
        } else {
          glTexture.width = width;
          glTexture.height = height;
          gl.texImage2D(baseTexture.target, 0, glTexture.internalFormat, width, height, 0, baseTexture.format, glTexture.type, this.data);
        }
        return true;
      };
      BufferResource2.prototype.dispose = function() {
        this.data = null;
      };
      BufferResource2.test = function(source) {
        return source instanceof Float32Array || source instanceof Uint8Array || source instanceof Uint32Array;
      };
      return BufferResource2;
    })(Resource)
  );
  var defaultBufferOptions = {
    scaleMode: SCALE_MODES.NEAREST,
    format: FORMATS.RGBA,
    alphaMode: ALPHA_MODES.NPM
  };
  var BaseTexture = (
    /** @class */
    (function(_super) {
      __extends(BaseTexture2, _super);
      function BaseTexture2(resource, options) {
        if (resource === void 0) {
          resource = null;
        }
        if (options === void 0) {
          options = null;
        }
        var _this = _super.call(this) || this;
        options = options || {};
        var alphaMode = options.alphaMode, mipmap = options.mipmap, anisotropicLevel = options.anisotropicLevel, scaleMode = options.scaleMode, width = options.width, height = options.height, wrapMode = options.wrapMode, format2 = options.format, type = options.type, target = options.target, resolution = options.resolution, resourceOptions = options.resourceOptions;
        if (resource && !(resource instanceof Resource)) {
          resource = autoDetectResource(resource, resourceOptions);
          resource.internal = true;
        }
        _this.resolution = resolution || settings.RESOLUTION;
        _this.width = Math.round((width || 0) * _this.resolution) / _this.resolution;
        _this.height = Math.round((height || 0) * _this.resolution) / _this.resolution;
        _this._mipmap = mipmap !== void 0 ? mipmap : settings.MIPMAP_TEXTURES;
        _this.anisotropicLevel = anisotropicLevel !== void 0 ? anisotropicLevel : settings.ANISOTROPIC_LEVEL;
        _this._wrapMode = wrapMode || settings.WRAP_MODE;
        _this._scaleMode = scaleMode !== void 0 ? scaleMode : settings.SCALE_MODE;
        _this.format = format2 || FORMATS.RGBA;
        _this.type = type || TYPES.UNSIGNED_BYTE;
        _this.target = target || TARGETS.TEXTURE_2D;
        _this.alphaMode = alphaMode !== void 0 ? alphaMode : ALPHA_MODES.UNPACK;
        _this.uid = uid();
        _this.touched = 0;
        _this.isPowerOfTwo = false;
        _this._refreshPOT();
        _this._glTextures = {};
        _this.dirtyId = 0;
        _this.dirtyStyleId = 0;
        _this.cacheId = null;
        _this.valid = width > 0 && height > 0;
        _this.textureCacheIds = [];
        _this.destroyed = false;
        _this.resource = null;
        _this._batchEnabled = 0;
        _this._batchLocation = 0;
        _this.parentTextureArray = null;
        _this.setResource(resource);
        return _this;
      }
      Object.defineProperty(BaseTexture2.prototype, "realWidth", {
        /**
         * Pixel width of the source of this texture
         * @readonly
         */
        get: function() {
          return Math.round(this.width * this.resolution);
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(BaseTexture2.prototype, "realHeight", {
        /**
         * Pixel height of the source of this texture
         * @readonly
         */
        get: function() {
          return Math.round(this.height * this.resolution);
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(BaseTexture2.prototype, "mipmap", {
        /**
         * Mipmap mode of the texture, affects downscaled images
         * @default PIXI.settings.MIPMAP_TEXTURES
         */
        get: function() {
          return this._mipmap;
        },
        set: function(value) {
          if (this._mipmap !== value) {
            this._mipmap = value;
            this.dirtyStyleId++;
          }
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(BaseTexture2.prototype, "scaleMode", {
        /**
         * The scale mode to apply when scaling this texture
         * @default PIXI.settings.SCALE_MODE
         */
        get: function() {
          return this._scaleMode;
        },
        set: function(value) {
          if (this._scaleMode !== value) {
            this._scaleMode = value;
            this.dirtyStyleId++;
          }
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(BaseTexture2.prototype, "wrapMode", {
        /**
         * How the texture wraps
         * @default PIXI.settings.WRAP_MODE
         */
        get: function() {
          return this._wrapMode;
        },
        set: function(value) {
          if (this._wrapMode !== value) {
            this._wrapMode = value;
            this.dirtyStyleId++;
          }
        },
        enumerable: false,
        configurable: true
      });
      BaseTexture2.prototype.setStyle = function(scaleMode, mipmap) {
        var dirty;
        if (scaleMode !== void 0 && scaleMode !== this.scaleMode) {
          this.scaleMode = scaleMode;
          dirty = true;
        }
        if (mipmap !== void 0 && mipmap !== this.mipmap) {
          this.mipmap = mipmap;
          dirty = true;
        }
        if (dirty) {
          this.dirtyStyleId++;
        }
        return this;
      };
      BaseTexture2.prototype.setSize = function(desiredWidth, desiredHeight, resolution) {
        resolution = resolution || this.resolution;
        return this.setRealSize(desiredWidth * resolution, desiredHeight * resolution, resolution);
      };
      BaseTexture2.prototype.setRealSize = function(realWidth, realHeight, resolution) {
        this.resolution = resolution || this.resolution;
        this.width = Math.round(realWidth) / this.resolution;
        this.height = Math.round(realHeight) / this.resolution;
        this._refreshPOT();
        this.update();
        return this;
      };
      BaseTexture2.prototype._refreshPOT = function() {
        this.isPowerOfTwo = isPow2(this.realWidth) && isPow2(this.realHeight);
      };
      BaseTexture2.prototype.setResolution = function(resolution) {
        var oldResolution = this.resolution;
        if (oldResolution === resolution) {
          return this;
        }
        this.resolution = resolution;
        if (this.valid) {
          this.width = Math.round(this.width * oldResolution) / resolution;
          this.height = Math.round(this.height * oldResolution) / resolution;
          this.emit("update", this);
        }
        this._refreshPOT();
        return this;
      };
      BaseTexture2.prototype.setResource = function(resource) {
        if (this.resource === resource) {
          return this;
        }
        if (this.resource) {
          throw new Error("Resource can be set only once");
        }
        resource.bind(this);
        this.resource = resource;
        return this;
      };
      BaseTexture2.prototype.update = function() {
        if (!this.valid) {
          if (this.width > 0 && this.height > 0) {
            this.valid = true;
            this.emit("loaded", this);
            this.emit("update", this);
          }
        } else {
          this.dirtyId++;
          this.dirtyStyleId++;
          this.emit("update", this);
        }
      };
      BaseTexture2.prototype.onError = function(event) {
        this.emit("error", this, event);
      };
      BaseTexture2.prototype.destroy = function() {
        if (this.resource) {
          this.resource.unbind(this);
          if (this.resource.internal) {
            this.resource.destroy();
          }
          this.resource = null;
        }
        if (this.cacheId) {
          delete BaseTextureCache[this.cacheId];
          delete TextureCache[this.cacheId];
          this.cacheId = null;
        }
        this.dispose();
        BaseTexture2.removeFromCache(this);
        this.textureCacheIds = null;
        this.destroyed = true;
      };
      BaseTexture2.prototype.dispose = function() {
        this.emit("dispose", this);
      };
      BaseTexture2.prototype.castToBaseTexture = function() {
        return this;
      };
      BaseTexture2.from = function(source, options, strict) {
        if (strict === void 0) {
          strict = settings.STRICT_TEXTURE_CACHE;
        }
        var isFrame = typeof source === "string";
        var cacheId = null;
        if (isFrame) {
          cacheId = source;
        } else {
          if (!source._pixiId) {
            var prefix = options && options.pixiIdPrefix || "pixiid";
            source._pixiId = prefix + "_" + uid();
          }
          cacheId = source._pixiId;
        }
        var baseTexture = BaseTextureCache[cacheId];
        if (isFrame && strict && !baseTexture) {
          throw new Error('The cacheId "' + cacheId + '" does not exist in BaseTextureCache.');
        }
        if (!baseTexture) {
          baseTexture = new BaseTexture2(source, options);
          baseTexture.cacheId = cacheId;
          BaseTexture2.addToCache(baseTexture, cacheId);
        }
        return baseTexture;
      };
      BaseTexture2.fromBuffer = function(buffer, width, height, options) {
        buffer = buffer || new Float32Array(width * height * 4);
        var resource = new BufferResource(buffer, { width, height });
        var type = buffer instanceof Float32Array ? TYPES.FLOAT : TYPES.UNSIGNED_BYTE;
        return new BaseTexture2(resource, Object.assign({}, defaultBufferOptions, options || { width, height, type }));
      };
      BaseTexture2.addToCache = function(baseTexture, id) {
        if (id) {
          if (baseTexture.textureCacheIds.indexOf(id) === -1) {
            baseTexture.textureCacheIds.push(id);
          }
          if (BaseTextureCache[id]) {
            console.warn("BaseTexture added to the cache with an id [" + id + "] that already had an entry");
          }
          BaseTextureCache[id] = baseTexture;
        }
      };
      BaseTexture2.removeFromCache = function(baseTexture) {
        if (typeof baseTexture === "string") {
          var baseTextureFromCache = BaseTextureCache[baseTexture];
          if (baseTextureFromCache) {
            var index = baseTextureFromCache.textureCacheIds.indexOf(baseTexture);
            if (index > -1) {
              baseTextureFromCache.textureCacheIds.splice(index, 1);
            }
            delete BaseTextureCache[baseTexture];
            return baseTextureFromCache;
          }
        } else if (baseTexture && baseTexture.textureCacheIds) {
          for (var i = 0; i < baseTexture.textureCacheIds.length; ++i) {
            delete BaseTextureCache[baseTexture.textureCacheIds[i]];
          }
          baseTexture.textureCacheIds.length = 0;
          return baseTexture;
        }
        return null;
      };
      BaseTexture2._globalBatch = 0;
      return BaseTexture2;
    })(import_eventemitter3.default)
  );
  var AbstractMultiResource = (
    /** @class */
    (function(_super) {
      __extends(AbstractMultiResource2, _super);
      function AbstractMultiResource2(length, options) {
        var _this = this;
        var _a = options || {}, width = _a.width, height = _a.height;
        _this = _super.call(this, width, height) || this;
        _this.items = [];
        _this.itemDirtyIds = [];
        for (var i = 0; i < length; i++) {
          var partTexture = new BaseTexture();
          _this.items.push(partTexture);
          _this.itemDirtyIds.push(-2);
        }
        _this.length = length;
        _this._load = null;
        _this.baseTexture = null;
        return _this;
      }
      AbstractMultiResource2.prototype.initFromArray = function(resources2, options) {
        for (var i = 0; i < this.length; i++) {
          if (!resources2[i]) {
            continue;
          }
          if (resources2[i].castToBaseTexture) {
            this.addBaseTextureAt(resources2[i].castToBaseTexture(), i);
          } else if (resources2[i] instanceof Resource) {
            this.addResourceAt(resources2[i], i);
          } else {
            this.addResourceAt(autoDetectResource(resources2[i], options), i);
          }
        }
      };
      AbstractMultiResource2.prototype.dispose = function() {
        for (var i = 0, len = this.length; i < len; i++) {
          this.items[i].destroy();
        }
        this.items = null;
        this.itemDirtyIds = null;
        this._load = null;
      };
      AbstractMultiResource2.prototype.addResourceAt = function(resource, index) {
        if (!this.items[index]) {
          throw new Error("Index " + index + " is out of bounds");
        }
        if (resource.valid && !this.valid) {
          this.resize(resource.width, resource.height);
        }
        this.items[index].setResource(resource);
        return this;
      };
      AbstractMultiResource2.prototype.bind = function(baseTexture) {
        if (this.baseTexture !== null) {
          throw new Error("Only one base texture per TextureArray is allowed");
        }
        _super.prototype.bind.call(this, baseTexture);
        for (var i = 0; i < this.length; i++) {
          this.items[i].parentTextureArray = baseTexture;
          this.items[i].on("update", baseTexture.update, baseTexture);
        }
      };
      AbstractMultiResource2.prototype.unbind = function(baseTexture) {
        _super.prototype.unbind.call(this, baseTexture);
        for (var i = 0; i < this.length; i++) {
          this.items[i].parentTextureArray = null;
          this.items[i].off("update", baseTexture.update, baseTexture);
        }
      };
      AbstractMultiResource2.prototype.load = function() {
        var _this = this;
        if (this._load) {
          return this._load;
        }
        var resources2 = this.items.map(function(item) {
          return item.resource;
        }).filter(function(item) {
          return item;
        });
        var promises = resources2.map(function(item) {
          return item.load();
        });
        this._load = Promise.all(promises).then(function() {
          var _a = _this.items[0], realWidth = _a.realWidth, realHeight = _a.realHeight;
          _this.resize(realWidth, realHeight);
          return Promise.resolve(_this);
        });
        return this._load;
      };
      return AbstractMultiResource2;
    })(Resource)
  );
  var ArrayResource = (
    /** @class */
    (function(_super) {
      __extends(ArrayResource2, _super);
      function ArrayResource2(source, options) {
        var _this = this;
        var _a = options || {}, width = _a.width, height = _a.height;
        var urls;
        var length;
        if (Array.isArray(source)) {
          urls = source;
          length = source.length;
        } else {
          length = source;
        }
        _this = _super.call(this, length, { width, height }) || this;
        if (urls) {
          _this.initFromArray(urls, options);
        }
        return _this;
      }
      ArrayResource2.prototype.addBaseTextureAt = function(baseTexture, index) {
        if (baseTexture.resource) {
          this.addResourceAt(baseTexture.resource, index);
        } else {
          throw new Error("ArrayResource does not support RenderTexture");
        }
        return this;
      };
      ArrayResource2.prototype.bind = function(baseTexture) {
        _super.prototype.bind.call(this, baseTexture);
        baseTexture.target = TARGETS.TEXTURE_2D_ARRAY;
      };
      ArrayResource2.prototype.upload = function(renderer, texture, glTexture) {
        var _a = this, length = _a.length, itemDirtyIds = _a.itemDirtyIds, items = _a.items;
        var gl = renderer.gl;
        if (glTexture.dirtyId < 0) {
          gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, glTexture.internalFormat, this._width, this._height, length, 0, texture.format, glTexture.type, null);
        }
        for (var i = 0; i < length; i++) {
          var item = items[i];
          if (itemDirtyIds[i] < item.dirtyId) {
            itemDirtyIds[i] = item.dirtyId;
            if (item.valid) {
              gl.texSubImage3D(
                gl.TEXTURE_2D_ARRAY,
                0,
                0,
                // xoffset
                0,
                // yoffset
                i,
                // zoffset
                item.resource.width,
                item.resource.height,
                1,
                texture.format,
                glTexture.type,
                item.resource.source
              );
            }
          }
        }
        return true;
      };
      return ArrayResource2;
    })(AbstractMultiResource)
  );
  var BaseImageResource = (
    /** @class */
    (function(_super) {
      __extends(BaseImageResource2, _super);
      function BaseImageResource2(source) {
        var _this = this;
        var sourceAny = source;
        var width = sourceAny.naturalWidth || sourceAny.videoWidth || sourceAny.width;
        var height = sourceAny.naturalHeight || sourceAny.videoHeight || sourceAny.height;
        _this = _super.call(this, width, height) || this;
        _this.source = source;
        _this.noSubImage = false;
        return _this;
      }
      BaseImageResource2.crossOrigin = function(element, url2, crossorigin) {
        if (crossorigin === void 0 && url2.indexOf("data:") !== 0) {
          element.crossOrigin = determineCrossOrigin(url2);
        } else if (crossorigin !== false) {
          element.crossOrigin = typeof crossorigin === "string" ? crossorigin : "anonymous";
        }
      };
      BaseImageResource2.prototype.upload = function(renderer, baseTexture, glTexture, source) {
        var gl = renderer.gl;
        var width = baseTexture.realWidth;
        var height = baseTexture.realHeight;
        source = source || this.source;
        if (source instanceof HTMLImageElement) {
          if (!source.complete || source.naturalWidth === 0) {
            return false;
          }
        } else if (source instanceof HTMLVideoElement) {
          if (source.readyState <= 1) {
            return false;
          }
        }
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, baseTexture.alphaMode === ALPHA_MODES.UNPACK);
        if (!this.noSubImage && baseTexture.target === gl.TEXTURE_2D && glTexture.width === width && glTexture.height === height) {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, baseTexture.format, glTexture.type, source);
        } else {
          glTexture.width = width;
          glTexture.height = height;
          gl.texImage2D(baseTexture.target, 0, glTexture.internalFormat, baseTexture.format, glTexture.type, source);
        }
        return true;
      };
      BaseImageResource2.prototype.update = function() {
        if (this.destroyed) {
          return;
        }
        var source = this.source;
        var width = source.naturalWidth || source.videoWidth || source.width;
        var height = source.naturalHeight || source.videoHeight || source.height;
        this.resize(width, height);
        _super.prototype.update.call(this);
      };
      BaseImageResource2.prototype.dispose = function() {
        this.source = null;
      };
      return BaseImageResource2;
    })(Resource)
  );
  var CanvasResource = (
    /** @class */
    (function(_super) {
      __extends(CanvasResource2, _super);
      function CanvasResource2(source) {
        return _super.call(this, source) || this;
      }
      CanvasResource2.test = function(source) {
        var OffscreenCanvas = globalThis.OffscreenCanvas;
        if (OffscreenCanvas && source instanceof OffscreenCanvas) {
          return true;
        }
        return globalThis.HTMLCanvasElement && source instanceof HTMLCanvasElement;
      };
      return CanvasResource2;
    })(BaseImageResource)
  );
  var CubeResource = (
    /** @class */
    (function(_super) {
      __extends(CubeResource2, _super);
      function CubeResource2(source, options) {
        var _this = this;
        var _a = options || {}, width = _a.width, height = _a.height, autoLoad = _a.autoLoad, linkBaseTexture = _a.linkBaseTexture;
        if (source && source.length !== CubeResource2.SIDES) {
          throw new Error("Invalid length. Got " + source.length + ", expected 6");
        }
        _this = _super.call(this, 6, { width, height }) || this;
        for (var i = 0; i < CubeResource2.SIDES; i++) {
          _this.items[i].target = TARGETS.TEXTURE_CUBE_MAP_POSITIVE_X + i;
        }
        _this.linkBaseTexture = linkBaseTexture !== false;
        if (source) {
          _this.initFromArray(source, options);
        }
        if (autoLoad !== false) {
          _this.load();
        }
        return _this;
      }
      CubeResource2.prototype.bind = function(baseTexture) {
        _super.prototype.bind.call(this, baseTexture);
        baseTexture.target = TARGETS.TEXTURE_CUBE_MAP;
      };
      CubeResource2.prototype.addBaseTextureAt = function(baseTexture, index, linkBaseTexture) {
        if (!this.items[index]) {
          throw new Error("Index " + index + " is out of bounds");
        }
        if (!this.linkBaseTexture || baseTexture.parentTextureArray || Object.keys(baseTexture._glTextures).length > 0) {
          if (baseTexture.resource) {
            this.addResourceAt(baseTexture.resource, index);
          } else {
            throw new Error("CubeResource does not support copying of renderTexture.");
          }
        } else {
          baseTexture.target = TARGETS.TEXTURE_CUBE_MAP_POSITIVE_X + index;
          baseTexture.parentTextureArray = this.baseTexture;
          this.items[index] = baseTexture;
        }
        if (baseTexture.valid && !this.valid) {
          this.resize(baseTexture.realWidth, baseTexture.realHeight);
        }
        this.items[index] = baseTexture;
        return this;
      };
      CubeResource2.prototype.upload = function(renderer, _baseTexture, glTexture) {
        var dirty = this.itemDirtyIds;
        for (var i = 0; i < CubeResource2.SIDES; i++) {
          var side = this.items[i];
          if (dirty[i] < side.dirtyId || glTexture.dirtyId < _baseTexture.dirtyId) {
            if (side.valid && side.resource) {
              side.resource.upload(renderer, side, glTexture);
              dirty[i] = side.dirtyId;
            } else if (dirty[i] < -1) {
              renderer.gl.texImage2D(side.target, 0, glTexture.internalFormat, _baseTexture.realWidth, _baseTexture.realHeight, 0, _baseTexture.format, glTexture.type, null);
              dirty[i] = -1;
            }
          }
        }
        return true;
      };
      CubeResource2.test = function(source) {
        return Array.isArray(source) && source.length === CubeResource2.SIDES;
      };
      CubeResource2.SIDES = 6;
      return CubeResource2;
    })(AbstractMultiResource)
  );
  var ImageResource = (
    /** @class */
    (function(_super) {
      __extends(ImageResource2, _super);
      function ImageResource2(source, options) {
        var _this = this;
        options = options || {};
        if (!(source instanceof HTMLImageElement)) {
          var imageElement = new Image();
          BaseImageResource.crossOrigin(imageElement, source, options.crossorigin);
          imageElement.src = source;
          source = imageElement;
        }
        _this = _super.call(this, source) || this;
        if (!source.complete && !!_this._width && !!_this._height) {
          _this._width = 0;
          _this._height = 0;
        }
        _this.url = source.src;
        _this._process = null;
        _this.preserveBitmap = false;
        _this.createBitmap = (options.createBitmap !== void 0 ? options.createBitmap : settings.CREATE_IMAGE_BITMAP) && !!globalThis.createImageBitmap;
        _this.alphaMode = typeof options.alphaMode === "number" ? options.alphaMode : null;
        _this.bitmap = null;
        _this._load = null;
        if (options.autoLoad !== false) {
          _this.load();
        }
        return _this;
      }
      ImageResource2.prototype.load = function(createBitmap) {
        var _this = this;
        if (this._load) {
          return this._load;
        }
        if (createBitmap !== void 0) {
          this.createBitmap = createBitmap;
        }
        this._load = new Promise(function(resolve2, reject) {
          var source = _this.source;
          _this.url = source.src;
          var completed = function() {
            if (_this.destroyed) {
              return;
            }
            source.onload = null;
            source.onerror = null;
            _this.resize(source.width, source.height);
            _this._load = null;
            if (_this.createBitmap) {
              resolve2(_this.process());
            } else {
              resolve2(_this);
            }
          };
          if (source.complete && source.src) {
            completed();
          } else {
            source.onload = completed;
            source.onerror = function(event) {
              reject(event);
              _this.onError.emit(event);
            };
          }
        });
        return this._load;
      };
      ImageResource2.prototype.process = function() {
        var _this = this;
        var source = this.source;
        if (this._process !== null) {
          return this._process;
        }
        if (this.bitmap !== null || !globalThis.createImageBitmap) {
          return Promise.resolve(this);
        }
        var createImageBitmap = globalThis.createImageBitmap;
        var cors = !source.crossOrigin || source.crossOrigin === "anonymous";
        this._process = fetch(source.src, {
          mode: cors ? "cors" : "no-cors"
        }).then(function(r) {
          return r.blob();
        }).then(function(blob) {
          return createImageBitmap(blob, 0, 0, source.width, source.height, {
            premultiplyAlpha: _this.alphaMode === null || _this.alphaMode === ALPHA_MODES.UNPACK ? "premultiply" : "none"
          });
        }).then(function(bitmap) {
          if (_this.destroyed) {
            return Promise.reject();
          }
          _this.bitmap = bitmap;
          _this.update();
          _this._process = null;
          return Promise.resolve(_this);
        });
        return this._process;
      };
      ImageResource2.prototype.upload = function(renderer, baseTexture, glTexture) {
        if (typeof this.alphaMode === "number") {
          baseTexture.alphaMode = this.alphaMode;
        }
        if (!this.createBitmap) {
          return _super.prototype.upload.call(this, renderer, baseTexture, glTexture);
        }
        if (!this.bitmap) {
          this.process();
          if (!this.bitmap) {
            return false;
          }
        }
        _super.prototype.upload.call(this, renderer, baseTexture, glTexture, this.bitmap);
        if (!this.preserveBitmap) {
          var flag = true;
          var glTextures = baseTexture._glTextures;
          for (var key in glTextures) {
            var otherTex = glTextures[key];
            if (otherTex !== glTexture && otherTex.dirtyId !== baseTexture.dirtyId) {
              flag = false;
              break;
            }
          }
          if (flag) {
            if (this.bitmap.close) {
              this.bitmap.close();
            }
            this.bitmap = null;
          }
        }
        return true;
      };
      ImageResource2.prototype.dispose = function() {
        this.source.onload = null;
        this.source.onerror = null;
        _super.prototype.dispose.call(this);
        if (this.bitmap) {
          this.bitmap.close();
          this.bitmap = null;
        }
        this._process = null;
        this._load = null;
      };
      ImageResource2.test = function(source) {
        return typeof source === "string" || source instanceof HTMLImageElement;
      };
      return ImageResource2;
    })(BaseImageResource)
  );
  var SVGResource = (
    /** @class */
    (function(_super) {
      __extends(SVGResource2, _super);
      function SVGResource2(sourceBase64, options) {
        var _this = this;
        options = options || {};
        _this = _super.call(this, settings.ADAPTER.createCanvas()) || this;
        _this._width = 0;
        _this._height = 0;
        _this.svg = sourceBase64;
        _this.scale = options.scale || 1;
        _this._overrideWidth = options.width;
        _this._overrideHeight = options.height;
        _this._resolve = null;
        _this._crossorigin = options.crossorigin;
        _this._load = null;
        if (options.autoLoad !== false) {
          _this.load();
        }
        return _this;
      }
      SVGResource2.prototype.load = function() {
        var _this = this;
        if (this._load) {
          return this._load;
        }
        this._load = new Promise(function(resolve2) {
          _this._resolve = function() {
            _this.resize(_this.source.width, _this.source.height);
            resolve2(_this);
          };
          if (SVGResource2.SVG_XML.test(_this.svg.trim())) {
            if (!btoa) {
              throw new Error("Your browser doesn't support base64 conversions.");
            }
            _this.svg = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(_this.svg)));
          }
          _this._loadSvg();
        });
        return this._load;
      };
      SVGResource2.prototype._loadSvg = function() {
        var _this = this;
        var tempImage = new Image();
        BaseImageResource.crossOrigin(tempImage, this.svg, this._crossorigin);
        tempImage.src = this.svg;
        tempImage.onerror = function(event) {
          if (!_this._resolve) {
            return;
          }
          tempImage.onerror = null;
          _this.onError.emit(event);
        };
        tempImage.onload = function() {
          if (!_this._resolve) {
            return;
          }
          var svgWidth = tempImage.width;
          var svgHeight = tempImage.height;
          if (!svgWidth || !svgHeight) {
            throw new Error("The SVG image must have width and height defined (in pixels), canvas API needs them.");
          }
          var width = svgWidth * _this.scale;
          var height = svgHeight * _this.scale;
          if (_this._overrideWidth || _this._overrideHeight) {
            width = _this._overrideWidth || _this._overrideHeight / svgHeight * svgWidth;
            height = _this._overrideHeight || _this._overrideWidth / svgWidth * svgHeight;
          }
          width = Math.round(width);
          height = Math.round(height);
          var canvas = _this.source;
          canvas.width = width;
          canvas.height = height;
          canvas._pixiId = "canvas_" + uid();
          canvas.getContext("2d").drawImage(tempImage, 0, 0, svgWidth, svgHeight, 0, 0, width, height);
          _this._resolve();
          _this._resolve = null;
        };
      };
      SVGResource2.getSize = function(svgString) {
        var sizeMatch = SVGResource2.SVG_SIZE.exec(svgString);
        var size = {};
        if (sizeMatch) {
          size[sizeMatch[1]] = Math.round(parseFloat(sizeMatch[3]));
          size[sizeMatch[5]] = Math.round(parseFloat(sizeMatch[7]));
        }
        return size;
      };
      SVGResource2.prototype.dispose = function() {
        _super.prototype.dispose.call(this);
        this._resolve = null;
        this._crossorigin = null;
      };
      SVGResource2.test = function(source, extension) {
        return extension === "svg" || typeof source === "string" && source.startsWith("data:image/svg+xml") || typeof source === "string" && SVGResource2.SVG_XML.test(source);
      };
      SVGResource2.SVG_XML = /^(<\?xml[^?]+\?>)?\s*(<!--[^(-->)]*-->)?\s*\<svg/m;
      SVGResource2.SVG_SIZE = /<svg[^>]*(?:\s(width|height)=('|")(\d*(?:\.\d+)?)(?:px)?('|"))[^>]*(?:\s(width|height)=('|")(\d*(?:\.\d+)?)(?:px)?('|"))[^>]*>/i;
      return SVGResource2;
    })(BaseImageResource)
  );
  var VideoResource = (
    /** @class */
    (function(_super) {
      __extends(VideoResource2, _super);
      function VideoResource2(source, options) {
        var _this = this;
        options = options || {};
        if (!(source instanceof HTMLVideoElement)) {
          var videoElement = document.createElement("video");
          videoElement.setAttribute("preload", "auto");
          videoElement.setAttribute("webkit-playsinline", "");
          videoElement.setAttribute("playsinline", "");
          if (typeof source === "string") {
            source = [source];
          }
          var firstSrc = source[0].src || source[0];
          BaseImageResource.crossOrigin(videoElement, firstSrc, options.crossorigin);
          for (var i = 0; i < source.length; ++i) {
            var sourceElement = document.createElement("source");
            var _a = source[i], src = _a.src, mime = _a.mime;
            src = src || source[i];
            var baseSrc = src.split("?").shift().toLowerCase();
            var ext = baseSrc.slice(baseSrc.lastIndexOf(".") + 1);
            mime = mime || VideoResource2.MIME_TYPES[ext] || "video/" + ext;
            sourceElement.src = src;
            sourceElement.type = mime;
            videoElement.appendChild(sourceElement);
          }
          source = videoElement;
        }
        _this = _super.call(this, source) || this;
        _this.noSubImage = true;
        _this._autoUpdate = true;
        _this._isConnectedToTicker = false;
        _this._updateFPS = options.updateFPS || 0;
        _this._msToNextUpdate = 0;
        _this.autoPlay = options.autoPlay !== false;
        _this._load = null;
        _this._resolve = null;
        _this._onCanPlay = _this._onCanPlay.bind(_this);
        _this._onError = _this._onError.bind(_this);
        if (options.autoLoad !== false) {
          _this.load();
        }
        return _this;
      }
      VideoResource2.prototype.update = function(_deltaTime) {
        if (!this.destroyed) {
          var elapsedMS = Ticker.shared.elapsedMS * this.source.playbackRate;
          this._msToNextUpdate = Math.floor(this._msToNextUpdate - elapsedMS);
          if (!this._updateFPS || this._msToNextUpdate <= 0) {
            _super.prototype.update.call(this);
            this._msToNextUpdate = this._updateFPS ? Math.floor(1e3 / this._updateFPS) : 0;
          }
        }
      };
      VideoResource2.prototype.load = function() {
        var _this = this;
        if (this._load) {
          return this._load;
        }
        var source = this.source;
        if ((source.readyState === source.HAVE_ENOUGH_DATA || source.readyState === source.HAVE_FUTURE_DATA) && source.width && source.height) {
          source.complete = true;
        }
        source.addEventListener("play", this._onPlayStart.bind(this));
        source.addEventListener("pause", this._onPlayStop.bind(this));
        if (!this._isSourceReady()) {
          source.addEventListener("canplay", this._onCanPlay);
          source.addEventListener("canplaythrough", this._onCanPlay);
          source.addEventListener("error", this._onError, true);
        } else {
          this._onCanPlay();
        }
        this._load = new Promise(function(resolve2) {
          if (_this.valid) {
            resolve2(_this);
          } else {
            _this._resolve = resolve2;
            source.load();
          }
        });
        return this._load;
      };
      VideoResource2.prototype._onError = function(event) {
        this.source.removeEventListener("error", this._onError, true);
        this.onError.emit(event);
      };
      VideoResource2.prototype._isSourcePlaying = function() {
        var source = this.source;
        return !source.paused && !source.ended && this._isSourceReady();
      };
      VideoResource2.prototype._isSourceReady = function() {
        var source = this.source;
        return source.readyState > 2;
      };
      VideoResource2.prototype._onPlayStart = function() {
        if (!this.valid) {
          this._onCanPlay();
        }
        if (this.autoUpdate && !this._isConnectedToTicker) {
          Ticker.shared.add(this.update, this);
          this._isConnectedToTicker = true;
        }
      };
      VideoResource2.prototype._onPlayStop = function() {
        if (this._isConnectedToTicker) {
          Ticker.shared.remove(this.update, this);
          this._isConnectedToTicker = false;
        }
      };
      VideoResource2.prototype._onCanPlay = function() {
        var source = this.source;
        source.removeEventListener("canplay", this._onCanPlay);
        source.removeEventListener("canplaythrough", this._onCanPlay);
        var valid = this.valid;
        this.resize(source.videoWidth, source.videoHeight);
        if (!valid && this._resolve) {
          this._resolve(this);
          this._resolve = null;
        }
        if (this._isSourcePlaying()) {
          this._onPlayStart();
        } else if (this.autoPlay) {
          source.play();
        }
      };
      VideoResource2.prototype.dispose = function() {
        if (this._isConnectedToTicker) {
          Ticker.shared.remove(this.update, this);
          this._isConnectedToTicker = false;
        }
        var source = this.source;
        if (source) {
          source.removeEventListener("error", this._onError, true);
          source.pause();
          source.src = "";
          source.load();
        }
        _super.prototype.dispose.call(this);
      };
      Object.defineProperty(VideoResource2.prototype, "autoUpdate", {
        /** Should the base texture automatically update itself, set to true by default. */
        get: function() {
          return this._autoUpdate;
        },
        set: function(value) {
          if (value !== this._autoUpdate) {
            this._autoUpdate = value;
            if (!this._autoUpdate && this._isConnectedToTicker) {
              Ticker.shared.remove(this.update, this);
              this._isConnectedToTicker = false;
            } else if (this._autoUpdate && !this._isConnectedToTicker && this._isSourcePlaying()) {
              Ticker.shared.add(this.update, this);
              this._isConnectedToTicker = true;
            }
          }
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(VideoResource2.prototype, "updateFPS", {
        /**
         * How many times a second to update the texture from the video. Leave at 0 to update at every render.
         * A lower fps can help performance, as updating the texture at 60fps on a 30ps video may not be efficient.
         */
        get: function() {
          return this._updateFPS;
        },
        set: function(value) {
          if (value !== this._updateFPS) {
            this._updateFPS = value;
          }
        },
        enumerable: false,
        configurable: true
      });
      VideoResource2.test = function(source, extension) {
        return globalThis.HTMLVideoElement && source instanceof HTMLVideoElement || VideoResource2.TYPES.indexOf(extension) > -1;
      };
      VideoResource2.TYPES = ["mp4", "m4v", "webm", "ogg", "ogv", "h264", "avi", "mov"];
      VideoResource2.MIME_TYPES = {
        ogv: "video/ogg",
        mov: "video/quicktime",
        m4v: "video/mp4"
      };
      return VideoResource2;
    })(BaseImageResource)
  );
  var ImageBitmapResource = (
    /** @class */
    (function(_super) {
      __extends(ImageBitmapResource2, _super);
      function ImageBitmapResource2(source) {
        return _super.call(this, source) || this;
      }
      ImageBitmapResource2.test = function(source) {
        return !!globalThis.createImageBitmap && typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap;
      };
      return ImageBitmapResource2;
    })(BaseImageResource)
  );
  INSTALLED.push(ImageResource, ImageBitmapResource, CanvasResource, VideoResource, SVGResource, BufferResource, CubeResource, ArrayResource);
  var _resources = {
    __proto__: null,
    Resource,
    BaseImageResource,
    INSTALLED,
    autoDetectResource,
    AbstractMultiResource,
    ArrayResource,
    BufferResource,
    CanvasResource,
    CubeResource,
    ImageResource,
    SVGResource,
    VideoResource,
    ImageBitmapResource
  };
  var DepthResource = (
    /** @class */
    (function(_super) {
      __extends(DepthResource2, _super);
      function DepthResource2() {
        return _super !== null && _super.apply(this, arguments) || this;
      }
      DepthResource2.prototype.upload = function(renderer, baseTexture, glTexture) {
        var gl = renderer.gl;
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, baseTexture.alphaMode === ALPHA_MODES.UNPACK);
        var width = baseTexture.realWidth;
        var height = baseTexture.realHeight;
        if (glTexture.width === width && glTexture.height === height) {
          gl.texSubImage2D(baseTexture.target, 0, 0, 0, width, height, baseTexture.format, glTexture.type, this.data);
        } else {
          glTexture.width = width;
          glTexture.height = height;
          gl.texImage2D(baseTexture.target, 0, glTexture.internalFormat, width, height, 0, baseTexture.format, glTexture.type, this.data);
        }
        return true;
      };
      return DepthResource2;
    })(BufferResource)
  );
  var Framebuffer = (
    /** @class */
    (function() {
      function Framebuffer2(width, height) {
        this.width = Math.round(width || 100);
        this.height = Math.round(height || 100);
        this.stencil = false;
        this.depth = false;
        this.dirtyId = 0;
        this.dirtyFormat = 0;
        this.dirtySize = 0;
        this.depthTexture = null;
        this.colorTextures = [];
        this.glFramebuffers = {};
        this.disposeRunner = new Runner("disposeFramebuffer");
        this.multisample = MSAA_QUALITY.NONE;
      }
      Object.defineProperty(Framebuffer2.prototype, "colorTexture", {
        /**
         * Reference to the colorTexture.
         * @readonly
         */
        get: function() {
          return this.colorTextures[0];
        },
        enumerable: false,
        configurable: true
      });
      Framebuffer2.prototype.addColorTexture = function(index, texture) {
        if (index === void 0) {
          index = 0;
        }
        this.colorTextures[index] = texture || new BaseTexture(null, {
          scaleMode: SCALE_MODES.NEAREST,
          resolution: 1,
          mipmap: MIPMAP_MODES.OFF,
          width: this.width,
          height: this.height
        });
        this.dirtyId++;
        this.dirtyFormat++;
        return this;
      };
      Framebuffer2.prototype.addDepthTexture = function(texture) {
        this.depthTexture = texture || new BaseTexture(new DepthResource(null, { width: this.width, height: this.height }), {
          scaleMode: SCALE_MODES.NEAREST,
          resolution: 1,
          width: this.width,
          height: this.height,
          mipmap: MIPMAP_MODES.OFF,
          format: FORMATS.DEPTH_COMPONENT,
          type: TYPES.UNSIGNED_SHORT
        });
        this.dirtyId++;
        this.dirtyFormat++;
        return this;
      };
      Framebuffer2.prototype.enableDepth = function() {
        this.depth = true;
        this.dirtyId++;
        this.dirtyFormat++;
        return this;
      };
      Framebuffer2.prototype.enableStencil = function() {
        this.stencil = true;
        this.dirtyId++;
        this.dirtyFormat++;
        return this;
      };
      Framebuffer2.prototype.resize = function(width, height) {
        width = Math.round(width);
        height = Math.round(height);
        if (width === this.width && height === this.height) {
          return;
        }
        this.width = width;
        this.height = height;
        this.dirtyId++;
        this.dirtySize++;
        for (var i = 0; i < this.colorTextures.length; i++) {
          var texture = this.colorTextures[i];
          var resolution = texture.resolution;
          texture.setSize(width / resolution, height / resolution);
        }
        if (this.depthTexture) {
          var resolution = this.depthTexture.resolution;
          this.depthTexture.setSize(width / resolution, height / resolution);
        }
      };
      Framebuffer2.prototype.dispose = function() {
        this.disposeRunner.emit(this, false);
      };
      Framebuffer2.prototype.destroyDepthTexture = function() {
        if (this.depthTexture) {
          this.depthTexture.destroy();
          this.depthTexture = null;
          ++this.dirtyId;
          ++this.dirtyFormat;
        }
      };
      return Framebuffer2;
    })()
  );
  var BaseRenderTexture = (
    /** @class */
    (function(_super) {
      __extends(BaseRenderTexture2, _super);
      function BaseRenderTexture2(options) {
        if (options === void 0) {
          options = {};
        }
        var _this = this;
        if (typeof options === "number") {
          var width = arguments[0];
          var height = arguments[1];
          var scaleMode = arguments[2];
          var resolution = arguments[3];
          options = { width, height, scaleMode, resolution };
        }
        options.width = options.width || 100;
        options.height = options.height || 100;
        options.multisample = options.multisample !== void 0 ? options.multisample : MSAA_QUALITY.NONE;
        _this = _super.call(this, null, options) || this;
        _this.mipmap = MIPMAP_MODES.OFF;
        _this.valid = true;
        _this.clearColor = [0, 0, 0, 0];
        _this.framebuffer = new Framebuffer(_this.realWidth, _this.realHeight).addColorTexture(0, _this);
        _this.framebuffer.multisample = options.multisample;
        _this.maskStack = [];
        _this.filterStack = [{}];
        return _this;
      }
      BaseRenderTexture2.prototype.resize = function(desiredWidth, desiredHeight) {
        this.framebuffer.resize(desiredWidth * this.resolution, desiredHeight * this.resolution);
        this.setRealSize(this.framebuffer.width, this.framebuffer.height);
      };
      BaseRenderTexture2.prototype.dispose = function() {
        this.framebuffer.dispose();
        _super.prototype.dispose.call(this);
      };
      BaseRenderTexture2.prototype.destroy = function() {
        _super.prototype.destroy.call(this);
        this.framebuffer.destroyDepthTexture();
        this.framebuffer = null;
      };
      return BaseRenderTexture2;
    })(BaseTexture)
  );
  var TextureUvs = (
    /** @class */
    (function() {
      function TextureUvs2() {
        this.x0 = 0;
        this.y0 = 0;
        this.x1 = 1;
        this.y1 = 0;
        this.x2 = 1;
        this.y2 = 1;
        this.x3 = 0;
        this.y3 = 1;
        this.uvsFloat32 = new Float32Array(8);
      }
      TextureUvs2.prototype.set = function(frame, baseFrame, rotate) {
        var tw = baseFrame.width;
        var th = baseFrame.height;
        if (rotate) {
          var w2 = frame.width / 2 / tw;
          var h2 = frame.height / 2 / th;
          var cX = frame.x / tw + w2;
          var cY = frame.y / th + h2;
          rotate = groupD8.add(rotate, groupD8.NW);
          this.x0 = cX + w2 * groupD8.uX(rotate);
          this.y0 = cY + h2 * groupD8.uY(rotate);
          rotate = groupD8.add(rotate, 2);
          this.x1 = cX + w2 * groupD8.uX(rotate);
          this.y1 = cY + h2 * groupD8.uY(rotate);
          rotate = groupD8.add(rotate, 2);
          this.x2 = cX + w2 * groupD8.uX(rotate);
          this.y2 = cY + h2 * groupD8.uY(rotate);
          rotate = groupD8.add(rotate, 2);
          this.x3 = cX + w2 * groupD8.uX(rotate);
          this.y3 = cY + h2 * groupD8.uY(rotate);
        } else {
          this.x0 = frame.x / tw;
          this.y0 = frame.y / th;
          this.x1 = (frame.x + frame.width) / tw;
          this.y1 = frame.y / th;
          this.x2 = (frame.x + frame.width) / tw;
          this.y2 = (frame.y + frame.height) / th;
          this.x3 = frame.x / tw;
          this.y3 = (frame.y + frame.height) / th;
        }
        this.uvsFloat32[0] = this.x0;
        this.uvsFloat32[1] = this.y0;
        this.uvsFloat32[2] = this.x1;
        this.uvsFloat32[3] = this.y1;
        this.uvsFloat32[4] = this.x2;
        this.uvsFloat32[5] = this.y2;
        this.uvsFloat32[6] = this.x3;
        this.uvsFloat32[7] = this.y3;
      };
      TextureUvs2.prototype.toString = function() {
        return "[@pixi/core:TextureUvs " + ("x0=" + this.x0 + " y0=" + this.y0 + " ") + ("x1=" + this.x1 + " y1=" + this.y1 + " x2=" + this.x2 + " ") + ("y2=" + this.y2 + " x3=" + this.x3 + " y3=" + this.y3) + "]";
      };
      return TextureUvs2;
    })()
  );
  var DEFAULT_UVS = new TextureUvs();
  function removeAllHandlers(tex) {
    tex.destroy = function _emptyDestroy() {
    };
    tex.on = function _emptyOn() {
    };
    tex.once = function _emptyOnce() {
    };
    tex.emit = function _emptyEmit() {
    };
  }
  var Texture = (
    /** @class */
    (function(_super) {
      __extends(Texture2, _super);
      function Texture2(baseTexture, frame, orig, trim, rotate, anchor) {
        var _this = _super.call(this) || this;
        _this.noFrame = false;
        if (!frame) {
          _this.noFrame = true;
          frame = new Rectangle(0, 0, 1, 1);
        }
        if (baseTexture instanceof Texture2) {
          baseTexture = baseTexture.baseTexture;
        }
        _this.baseTexture = baseTexture;
        _this._frame = frame;
        _this.trim = trim;
        _this.valid = false;
        _this._uvs = DEFAULT_UVS;
        _this.uvMatrix = null;
        _this.orig = orig || frame;
        _this._rotate = Number(rotate || 0);
        if (rotate === true) {
          _this._rotate = 2;
        } else if (_this._rotate % 2 !== 0) {
          throw new Error("attempt to use diamond-shaped UVs. If you are sure, set rotation manually");
        }
        _this.defaultAnchor = anchor ? new Point(anchor.x, anchor.y) : new Point(0, 0);
        _this._updateID = 0;
        _this.textureCacheIds = [];
        if (!baseTexture.valid) {
          baseTexture.once("loaded", _this.onBaseTextureUpdated, _this);
        } else if (_this.noFrame) {
          if (baseTexture.valid) {
            _this.onBaseTextureUpdated(baseTexture);
          }
        } else {
          _this.frame = frame;
        }
        if (_this.noFrame) {
          baseTexture.on("update", _this.onBaseTextureUpdated, _this);
        }
        return _this;
      }
      Texture2.prototype.update = function() {
        if (this.baseTexture.resource) {
          this.baseTexture.resource.update();
        }
      };
      Texture2.prototype.onBaseTextureUpdated = function(baseTexture) {
        if (this.noFrame) {
          if (!this.baseTexture.valid) {
            return;
          }
          this._frame.width = baseTexture.width;
          this._frame.height = baseTexture.height;
          this.valid = true;
          this.updateUvs();
        } else {
          this.frame = this._frame;
        }
        this.emit("update", this);
      };
      Texture2.prototype.destroy = function(destroyBase) {
        if (this.baseTexture) {
          if (destroyBase) {
            var resource = this.baseTexture.resource;
            if (resource && resource.url && TextureCache[resource.url]) {
              Texture2.removeFromCache(resource.url);
            }
            this.baseTexture.destroy();
          }
          this.baseTexture.off("loaded", this.onBaseTextureUpdated, this);
          this.baseTexture.off("update", this.onBaseTextureUpdated, this);
          this.baseTexture = null;
        }
        this._frame = null;
        this._uvs = null;
        this.trim = null;
        this.orig = null;
        this.valid = false;
        Texture2.removeFromCache(this);
        this.textureCacheIds = null;
      };
      Texture2.prototype.clone = function() {
        var clonedFrame = this._frame.clone();
        var clonedOrig = this._frame === this.orig ? clonedFrame : this.orig.clone();
        var clonedTexture = new Texture2(this.baseTexture, !this.noFrame && clonedFrame, clonedOrig, this.trim && this.trim.clone(), this.rotate, this.defaultAnchor);
        if (this.noFrame) {
          clonedTexture._frame = clonedFrame;
        }
        return clonedTexture;
      };
      Texture2.prototype.updateUvs = function() {
        if (this._uvs === DEFAULT_UVS) {
          this._uvs = new TextureUvs();
        }
        this._uvs.set(this._frame, this.baseTexture, this.rotate);
        this._updateID++;
      };
      Texture2.from = function(source, options, strict) {
        if (options === void 0) {
          options = {};
        }
        if (strict === void 0) {
          strict = settings.STRICT_TEXTURE_CACHE;
        }
        var isFrame = typeof source === "string";
        var cacheId = null;
        if (isFrame) {
          cacheId = source;
        } else if (source instanceof BaseTexture) {
          if (!source.cacheId) {
            var prefix = options && options.pixiIdPrefix || "pixiid";
            source.cacheId = prefix + "-" + uid();
            BaseTexture.addToCache(source, source.cacheId);
          }
          cacheId = source.cacheId;
        } else {
          if (!source._pixiId) {
            var prefix = options && options.pixiIdPrefix || "pixiid";
            source._pixiId = prefix + "_" + uid();
          }
          cacheId = source._pixiId;
        }
        var texture = TextureCache[cacheId];
        if (isFrame && strict && !texture) {
          throw new Error('The cacheId "' + cacheId + '" does not exist in TextureCache.');
        }
        if (!texture && !(source instanceof BaseTexture)) {
          if (!options.resolution) {
            options.resolution = getResolutionOfUrl(source);
          }
          texture = new Texture2(new BaseTexture(source, options));
          texture.baseTexture.cacheId = cacheId;
          BaseTexture.addToCache(texture.baseTexture, cacheId);
          Texture2.addToCache(texture, cacheId);
        } else if (!texture && source instanceof BaseTexture) {
          texture = new Texture2(source);
          Texture2.addToCache(texture, cacheId);
        }
        return texture;
      };
      Texture2.fromURL = function(url2, options) {
        var resourceOptions = Object.assign({ autoLoad: false }, options === null || options === void 0 ? void 0 : options.resourceOptions);
        var texture = Texture2.from(url2, Object.assign({ resourceOptions }, options), false);
        var resource = texture.baseTexture.resource;
        if (texture.baseTexture.valid) {
          return Promise.resolve(texture);
        }
        return resource.load().then(function() {
          return Promise.resolve(texture);
        });
      };
      Texture2.fromBuffer = function(buffer, width, height, options) {
        return new Texture2(BaseTexture.fromBuffer(buffer, width, height, options));
      };
      Texture2.fromLoader = function(source, imageUrl, name, options) {
        var baseTexture = new BaseTexture(source, Object.assign({
          scaleMode: settings.SCALE_MODE,
          resolution: getResolutionOfUrl(imageUrl)
        }, options));
        var resource = baseTexture.resource;
        if (resource instanceof ImageResource) {
          resource.url = imageUrl;
        }
        var texture = new Texture2(baseTexture);
        if (!name) {
          name = imageUrl;
        }
        BaseTexture.addToCache(texture.baseTexture, name);
        Texture2.addToCache(texture, name);
        if (name !== imageUrl) {
          BaseTexture.addToCache(texture.baseTexture, imageUrl);
          Texture2.addToCache(texture, imageUrl);
        }
        if (texture.baseTexture.valid) {
          return Promise.resolve(texture);
        }
        return new Promise(function(resolve2) {
          texture.baseTexture.once("loaded", function() {
            return resolve2(texture);
          });
        });
      };
      Texture2.addToCache = function(texture, id) {
        if (id) {
          if (texture.textureCacheIds.indexOf(id) === -1) {
            texture.textureCacheIds.push(id);
          }
          if (TextureCache[id]) {
            console.warn("Texture added to the cache with an id [" + id + "] that already had an entry");
          }
          TextureCache[id] = texture;
        }
      };
      Texture2.removeFromCache = function(texture) {
        if (typeof texture === "string") {
          var textureFromCache = TextureCache[texture];
          if (textureFromCache) {
            var index = textureFromCache.textureCacheIds.indexOf(texture);
            if (index > -1) {
              textureFromCache.textureCacheIds.splice(index, 1);
            }
            delete TextureCache[texture];
            return textureFromCache;
          }
        } else if (texture && texture.textureCacheIds) {
          for (var i = 0; i < texture.textureCacheIds.length; ++i) {
            if (TextureCache[texture.textureCacheIds[i]] === texture) {
              delete TextureCache[texture.textureCacheIds[i]];
            }
          }
          texture.textureCacheIds.length = 0;
          return texture;
        }
        return null;
      };
      Object.defineProperty(Texture2.prototype, "resolution", {
        /**
         * Returns resolution of baseTexture
         * @readonly
         */
        get: function() {
          return this.baseTexture.resolution;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(Texture2.prototype, "frame", {
        /**
         * The frame specifies the region of the base texture that this texture uses.
         * Please call `updateUvs()` after you change coordinates of `frame` manually.
         */
        get: function() {
          return this._frame;
        },
        set: function(frame) {
          this._frame = frame;
          this.noFrame = false;
          var x = frame.x, y = frame.y, width = frame.width, height = frame.height;
          var xNotFit = x + width > this.baseTexture.width;
          var yNotFit = y + height > this.baseTexture.height;
          if (xNotFit || yNotFit) {
            var relationship = xNotFit && yNotFit ? "and" : "or";
            var errorX = "X: " + x + " + " + width + " = " + (x + width) + " > " + this.baseTexture.width;
            var errorY = "Y: " + y + " + " + height + " = " + (y + height) + " > " + this.baseTexture.height;
            throw new Error("Texture Error: frame does not fit inside the base Texture dimensions: " + (errorX + " " + relationship + " " + errorY));
          }
          this.valid = width && height && this.baseTexture.valid;
          if (!this.trim && !this.rotate) {
            this.orig = frame;
          }
          if (this.valid) {
            this.updateUvs();
          }
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(Texture2.prototype, "rotate", {
        /**
         * Indicates whether the texture is rotated inside the atlas
         * set to 2 to compensate for texture packer rotation
         * set to 6 to compensate for spine packer rotation
         * can be used to rotate or mirror sprites
         * See {@link PIXI.groupD8} for explanation
         */
        get: function() {
          return this._rotate;
        },
        set: function(rotate) {
          this._rotate = rotate;
          if (this.valid) {
            this.updateUvs();
          }
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(Texture2.prototype, "width", {
        /** The width of the Texture in pixels. */
        get: function() {
          return this.orig.width;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(Texture2.prototype, "height", {
        /** The height of the Texture in pixels. */
        get: function() {
          return this.orig.height;
        },
        enumerable: false,
        configurable: true
      });
      Texture2.prototype.castToBaseTexture = function() {
        return this.baseTexture;
      };
      Object.defineProperty(Texture2, "EMPTY", {
        /** An empty texture, used often to not have to create multiple empty textures. Can not be destroyed. */
        get: function() {
          if (!Texture2._EMPTY) {
            Texture2._EMPTY = new Texture2(new BaseTexture());
            removeAllHandlers(Texture2._EMPTY);
            removeAllHandlers(Texture2._EMPTY.baseTexture);
          }
          return Texture2._EMPTY;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(Texture2, "WHITE", {
        /** A white texture of 16x16 size, used for graphics and other things Can not be destroyed. */
        get: function() {
          if (!Texture2._WHITE) {
            var canvas = settings.ADAPTER.createCanvas(16, 16);
            var context2 = canvas.getContext("2d");
            canvas.width = 16;
            canvas.height = 16;
            context2.fillStyle = "white";
            context2.fillRect(0, 0, 16, 16);
            Texture2._WHITE = new Texture2(BaseTexture.from(canvas));
            removeAllHandlers(Texture2._WHITE);
            removeAllHandlers(Texture2._WHITE.baseTexture);
          }
          return Texture2._WHITE;
        },
        enumerable: false,
        configurable: true
      });
      return Texture2;
    })(import_eventemitter3.default)
  );
  var RenderTexture = (
    /** @class */
    (function(_super) {
      __extends(RenderTexture2, _super);
      function RenderTexture2(baseRenderTexture, frame) {
        var _this = _super.call(this, baseRenderTexture, frame) || this;
        _this.valid = true;
        _this.filterFrame = null;
        _this.filterPoolKey = null;
        _this.updateUvs();
        return _this;
      }
      Object.defineProperty(RenderTexture2.prototype, "framebuffer", {
        /**
         * Shortcut to `this.baseTexture.framebuffer`, saves baseTexture cast.
         * @readonly
         */
        get: function() {
          return this.baseTexture.framebuffer;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(RenderTexture2.prototype, "multisample", {
        /**
         * Shortcut to `this.framebuffer.multisample`.
         * @default PIXI.MSAA_QUALITY.NONE
         */
        get: function() {
          return this.framebuffer.multisample;
        },
        set: function(value) {
          this.framebuffer.multisample = value;
        },
        enumerable: false,
        configurable: true
      });
      RenderTexture2.prototype.resize = function(desiredWidth, desiredHeight, resizeBaseTexture) {
        if (resizeBaseTexture === void 0) {
          resizeBaseTexture = true;
        }
        var resolution = this.baseTexture.resolution;
        var width = Math.round(desiredWidth * resolution) / resolution;
        var height = Math.round(desiredHeight * resolution) / resolution;
        this.valid = width > 0 && height > 0;
        this._frame.width = this.orig.width = width;
        this._frame.height = this.orig.height = height;
        if (resizeBaseTexture) {
          this.baseTexture.resize(width, height);
        }
        this.updateUvs();
      };
      RenderTexture2.prototype.setResolution = function(resolution) {
        var baseTexture = this.baseTexture;
        if (baseTexture.resolution === resolution) {
          return;
        }
        baseTexture.setResolution(resolution);
        this.resize(baseTexture.width, baseTexture.height, false);
      };
      RenderTexture2.create = function(options) {
        var arguments$1 = arguments;
        var rest = [];
        for (var _i = 1; _i < arguments.length; _i++) {
          rest[_i - 1] = arguments$1[_i];
        }
        if (typeof options === "number") {
          deprecation("6.0.0", "Arguments (width, height, scaleMode, resolution) have been deprecated.");
          options = {
            width: options,
            height: rest[0],
            scaleMode: rest[1],
            resolution: rest[2]
          };
        }
        return new RenderTexture2(new BaseRenderTexture(options));
      };
      return RenderTexture2;
    })(Texture)
  );
  var RenderTexturePool = (
    /** @class */
    (function() {
      function RenderTexturePool2(textureOptions) {
        this.texturePool = {};
        this.textureOptions = textureOptions || {};
        this.enableFullScreen = false;
        this._pixelsWidth = 0;
        this._pixelsHeight = 0;
      }
      RenderTexturePool2.prototype.createTexture = function(realWidth, realHeight, multisample) {
        if (multisample === void 0) {
          multisample = MSAA_QUALITY.NONE;
        }
        var baseRenderTexture = new BaseRenderTexture(Object.assign({
          width: realWidth,
          height: realHeight,
          resolution: 1,
          multisample
        }, this.textureOptions));
        return new RenderTexture(baseRenderTexture);
      };
      RenderTexturePool2.prototype.getOptimalTexture = function(minWidth, minHeight, resolution, multisample) {
        if (resolution === void 0) {
          resolution = 1;
        }
        if (multisample === void 0) {
          multisample = MSAA_QUALITY.NONE;
        }
        var key;
        minWidth = Math.ceil(minWidth * resolution - 1e-6);
        minHeight = Math.ceil(minHeight * resolution - 1e-6);
        if (!this.enableFullScreen || minWidth !== this._pixelsWidth || minHeight !== this._pixelsHeight) {
          minWidth = nextPow2(minWidth);
          minHeight = nextPow2(minHeight);
          key = ((minWidth & 65535) << 16 | minHeight & 65535) >>> 0;
          if (multisample > 1) {
            key += multisample * 4294967296;
          }
        } else {
          key = multisample > 1 ? -multisample : -1;
        }
        if (!this.texturePool[key]) {
          this.texturePool[key] = [];
        }
        var renderTexture = this.texturePool[key].pop();
        if (!renderTexture) {
          renderTexture = this.createTexture(minWidth, minHeight, multisample);
        }
        renderTexture.filterPoolKey = key;
        renderTexture.setResolution(resolution);
        return renderTexture;
      };
      RenderTexturePool2.prototype.getFilterTexture = function(input, resolution, multisample) {
        var filterTexture = this.getOptimalTexture(input.width, input.height, resolution || input.resolution, multisample || MSAA_QUALITY.NONE);
        filterTexture.filterFrame = input.filterFrame;
        return filterTexture;
      };
      RenderTexturePool2.prototype.returnTexture = function(renderTexture) {
        var key = renderTexture.filterPoolKey;
        renderTexture.filterFrame = null;
        this.texturePool[key].push(renderTexture);
      };
      RenderTexturePool2.prototype.returnFilterTexture = function(renderTexture) {
        this.returnTexture(renderTexture);
      };
      RenderTexturePool2.prototype.clear = function(destroyTextures) {
        destroyTextures = destroyTextures !== false;
        if (destroyTextures) {
          for (var i in this.texturePool) {
            var textures = this.texturePool[i];
            if (textures) {
              for (var j = 0; j < textures.length; j++) {
                textures[j].destroy(true);
              }
            }
          }
        }
        this.texturePool = {};
      };
      RenderTexturePool2.prototype.setScreenSize = function(size) {
        if (size.width === this._pixelsWidth && size.height === this._pixelsHeight) {
          return;
        }
        this.enableFullScreen = size.width > 0 && size.height > 0;
        for (var i in this.texturePool) {
          if (!(Number(i) < 0)) {
            continue;
          }
          var textures = this.texturePool[i];
          if (textures) {
            for (var j = 0; j < textures.length; j++) {
              textures[j].destroy(true);
            }
          }
          this.texturePool[i] = [];
        }
        this._pixelsWidth = size.width;
        this._pixelsHeight = size.height;
      };
      RenderTexturePool2.SCREEN_KEY = -1;
      return RenderTexturePool2;
    })()
  );
  var Attribute = (
    /** @class */
    (function() {
      function Attribute2(buffer, size, normalized, type, stride, start, instance) {
        if (size === void 0) {
          size = 0;
        }
        if (normalized === void 0) {
          normalized = false;
        }
        if (type === void 0) {
          type = TYPES.FLOAT;
        }
        this.buffer = buffer;
        this.size = size;
        this.normalized = normalized;
        this.type = type;
        this.stride = stride;
        this.start = start;
        this.instance = instance;
      }
      Attribute2.prototype.destroy = function() {
        this.buffer = null;
      };
      Attribute2.from = function(buffer, size, normalized, type, stride) {
        return new Attribute2(buffer, size, normalized, type, stride);
      };
      return Attribute2;
    })()
  );
  var UID$4 = 0;
  var Buffer2 = (
    /** @class */
    (function() {
      function Buffer3(data, _static, index) {
        if (_static === void 0) {
          _static = true;
        }
        if (index === void 0) {
          index = false;
        }
        this.data = data || new Float32Array(1);
        this._glBuffers = {};
        this._updateID = 0;
        this.index = index;
        this.static = _static;
        this.id = UID$4++;
        this.disposeRunner = new Runner("disposeBuffer");
      }
      Buffer3.prototype.update = function(data) {
        if (data instanceof Array) {
          data = new Float32Array(data);
        }
        this.data = data || this.data;
        this._updateID++;
      };
      Buffer3.prototype.dispose = function() {
        this.disposeRunner.emit(this, false);
      };
      Buffer3.prototype.destroy = function() {
        this.dispose();
        this.data = null;
      };
      Object.defineProperty(Buffer3.prototype, "index", {
        get: function() {
          return this.type === BUFFER_TYPE.ELEMENT_ARRAY_BUFFER;
        },
        /**
         * Flags whether this is an index buffer.
         *
         * Index buffers are of type `ELEMENT_ARRAY_BUFFER`. Note that setting this property to false will make
         * the buffer of type `ARRAY_BUFFER`.
         *
         * For backwards compatibility.
         */
        set: function(value) {
          this.type = value ? BUFFER_TYPE.ELEMENT_ARRAY_BUFFER : BUFFER_TYPE.ARRAY_BUFFER;
        },
        enumerable: false,
        configurable: true
      });
      Buffer3.from = function(data) {
        if (data instanceof Array) {
          data = new Float32Array(data);
        }
        return new Buffer3(data);
      };
      return Buffer3;
    })()
  );
  var map$1 = {
    Float32Array,
    Uint32Array,
    Int32Array,
    Uint8Array
  };
  function interleaveTypedArrays(arrays, sizes) {
    var outSize = 0;
    var stride = 0;
    var views = {};
    for (var i = 0; i < arrays.length; i++) {
      stride += sizes[i];
      outSize += arrays[i].length;
    }
    var buffer = new ArrayBuffer(outSize * 4);
    var out = null;
    var littleOffset = 0;
    for (var i = 0; i < arrays.length; i++) {
      var size = sizes[i];
      var array = arrays[i];
      var type = getBufferType(array);
      if (!views[type]) {
        views[type] = new map$1[type](buffer);
      }
      out = views[type];
      for (var j = 0; j < array.length; j++) {
        var indexStart = (j / size | 0) * stride + littleOffset;
        var index = j % size;
        out[indexStart + index] = array[j];
      }
      littleOffset += size;
    }
    return new Float32Array(buffer);
  }
  var byteSizeMap$1 = { 5126: 4, 5123: 2, 5121: 1 };
  var UID$3 = 0;
  var map = {
    Float32Array,
    Uint32Array,
    Int32Array,
    Uint8Array,
    Uint16Array
  };
  var Geometry = (
    /** @class */
    (function() {
      function Geometry2(buffers, attributes) {
        if (buffers === void 0) {
          buffers = [];
        }
        if (attributes === void 0) {
          attributes = {};
        }
        this.buffers = buffers;
        this.indexBuffer = null;
        this.attributes = attributes;
        this.glVertexArrayObjects = {};
        this.id = UID$3++;
        this.instanced = false;
        this.instanceCount = 1;
        this.disposeRunner = new Runner("disposeGeometry");
        this.refCount = 0;
      }
      Geometry2.prototype.addAttribute = function(id, buffer, size, normalized, type, stride, start, instance) {
        if (size === void 0) {
          size = 0;
        }
        if (normalized === void 0) {
          normalized = false;
        }
        if (instance === void 0) {
          instance = false;
        }
        if (!buffer) {
          throw new Error("You must pass a buffer when creating an attribute");
        }
        if (!(buffer instanceof Buffer2)) {
          if (buffer instanceof Array) {
            buffer = new Float32Array(buffer);
          }
          buffer = new Buffer2(buffer);
        }
        var ids = id.split("|");
        if (ids.length > 1) {
          for (var i = 0; i < ids.length; i++) {
            this.addAttribute(ids[i], buffer, size, normalized, type);
          }
          return this;
        }
        var bufferIndex = this.buffers.indexOf(buffer);
        if (bufferIndex === -1) {
          this.buffers.push(buffer);
          bufferIndex = this.buffers.length - 1;
        }
        this.attributes[id] = new Attribute(bufferIndex, size, normalized, type, stride, start, instance);
        this.instanced = this.instanced || instance;
        return this;
      };
      Geometry2.prototype.getAttribute = function(id) {
        return this.attributes[id];
      };
      Geometry2.prototype.getBuffer = function(id) {
        return this.buffers[this.getAttribute(id).buffer];
      };
      Geometry2.prototype.addIndex = function(buffer) {
        if (!(buffer instanceof Buffer2)) {
          if (buffer instanceof Array) {
            buffer = new Uint16Array(buffer);
          }
          buffer = new Buffer2(buffer);
        }
        buffer.type = BUFFER_TYPE.ELEMENT_ARRAY_BUFFER;
        this.indexBuffer = buffer;
        if (this.buffers.indexOf(buffer) === -1) {
          this.buffers.push(buffer);
        }
        return this;
      };
      Geometry2.prototype.getIndex = function() {
        return this.indexBuffer;
      };
      Geometry2.prototype.interleave = function() {
        if (this.buffers.length === 1 || this.buffers.length === 2 && this.indexBuffer) {
          return this;
        }
        var arrays = [];
        var sizes = [];
        var interleavedBuffer = new Buffer2();
        var i;
        for (i in this.attributes) {
          var attribute = this.attributes[i];
          var buffer = this.buffers[attribute.buffer];
          arrays.push(buffer.data);
          sizes.push(attribute.size * byteSizeMap$1[attribute.type] / 4);
          attribute.buffer = 0;
        }
        interleavedBuffer.data = interleaveTypedArrays(arrays, sizes);
        for (i = 0; i < this.buffers.length; i++) {
          if (this.buffers[i] !== this.indexBuffer) {
            this.buffers[i].destroy();
          }
        }
        this.buffers = [interleavedBuffer];
        if (this.indexBuffer) {
          this.buffers.push(this.indexBuffer);
        }
        return this;
      };
      Geometry2.prototype.getSize = function() {
        for (var i in this.attributes) {
          var attribute = this.attributes[i];
          var buffer = this.buffers[attribute.buffer];
          return buffer.data.length / (attribute.stride / 4 || attribute.size);
        }
        return 0;
      };
      Geometry2.prototype.dispose = function() {
        this.disposeRunner.emit(this, false);
      };
      Geometry2.prototype.destroy = function() {
        this.dispose();
        this.buffers = null;
        this.indexBuffer = null;
        this.attributes = null;
      };
      Geometry2.prototype.clone = function() {
        var geometry = new Geometry2();
        for (var i = 0; i < this.buffers.length; i++) {
          geometry.buffers[i] = new Buffer2(this.buffers[i].data.slice(0));
        }
        for (var i in this.attributes) {
          var attrib = this.attributes[i];
          geometry.attributes[i] = new Attribute(attrib.buffer, attrib.size, attrib.normalized, attrib.type, attrib.stride, attrib.start, attrib.instance);
        }
        if (this.indexBuffer) {
          geometry.indexBuffer = geometry.buffers[this.buffers.indexOf(this.indexBuffer)];
          geometry.indexBuffer.type = BUFFER_TYPE.ELEMENT_ARRAY_BUFFER;
        }
        return geometry;
      };
      Geometry2.merge = function(geometries) {
        var geometryOut = new Geometry2();
        var arrays = [];
        var sizes = [];
        var offsets = [];
        var geometry;
        for (var i = 0; i < geometries.length; i++) {
          geometry = geometries[i];
          for (var j = 0; j < geometry.buffers.length; j++) {
            sizes[j] = sizes[j] || 0;
            sizes[j] += geometry.buffers[j].data.length;
            offsets[j] = 0;
          }
        }
        for (var i = 0; i < geometry.buffers.length; i++) {
          arrays[i] = new map[getBufferType(geometry.buffers[i].data)](sizes[i]);
          geometryOut.buffers[i] = new Buffer2(arrays[i]);
        }
        for (var i = 0; i < geometries.length; i++) {
          geometry = geometries[i];
          for (var j = 0; j < geometry.buffers.length; j++) {
            arrays[j].set(geometry.buffers[j].data, offsets[j]);
            offsets[j] += geometry.buffers[j].data.length;
          }
        }
        geometryOut.attributes = geometry.attributes;
        if (geometry.indexBuffer) {
          geometryOut.indexBuffer = geometryOut.buffers[geometry.buffers.indexOf(geometry.indexBuffer)];
          geometryOut.indexBuffer.type = BUFFER_TYPE.ELEMENT_ARRAY_BUFFER;
          var offset = 0;
          var stride = 0;
          var offset2 = 0;
          var bufferIndexToCount = 0;
          for (var i = 0; i < geometry.buffers.length; i++) {
            if (geometry.buffers[i] !== geometry.indexBuffer) {
              bufferIndexToCount = i;
              break;
            }
          }
          for (var i in geometry.attributes) {
            var attribute = geometry.attributes[i];
            if ((attribute.buffer | 0) === bufferIndexToCount) {
              stride += attribute.size * byteSizeMap$1[attribute.type] / 4;
            }
          }
          for (var i = 0; i < geometries.length; i++) {
            var indexBufferData = geometries[i].indexBuffer.data;
            for (var j = 0; j < indexBufferData.length; j++) {
              geometryOut.indexBuffer.data[j + offset2] += offset;
            }
            offset += geometries[i].buffers[bufferIndexToCount].data.length / stride;
            offset2 += indexBufferData.length;
          }
        }
        return geometryOut;
      };
      return Geometry2;
    })()
  );
  var Quad = (
    /** @class */
    (function(_super) {
      __extends(Quad2, _super);
      function Quad2() {
        var _this = _super.call(this) || this;
        _this.addAttribute("aVertexPosition", new Float32Array([
          0,
          0,
          1,
          0,
          1,
          1,
          0,
          1
        ])).addIndex([0, 1, 3, 2]);
        return _this;
      }
      return Quad2;
    })(Geometry)
  );
  var QuadUv = (
    /** @class */
    (function(_super) {
      __extends(QuadUv2, _super);
      function QuadUv2() {
        var _this = _super.call(this) || this;
        _this.vertices = new Float32Array([
          -1,
          -1,
          1,
          -1,
          1,
          1,
          -1,
          1
        ]);
        _this.uvs = new Float32Array([
          0,
          0,
          1,
          0,
          1,
          1,
          0,
          1
        ]);
        _this.vertexBuffer = new Buffer2(_this.vertices);
        _this.uvBuffer = new Buffer2(_this.uvs);
        _this.addAttribute("aVertexPosition", _this.vertexBuffer).addAttribute("aTextureCoord", _this.uvBuffer).addIndex([0, 1, 2, 0, 2, 3]);
        return _this;
      }
      QuadUv2.prototype.map = function(targetTextureFrame, destinationFrame) {
        var x = 0;
        var y = 0;
        this.uvs[0] = x;
        this.uvs[1] = y;
        this.uvs[2] = x + destinationFrame.width / targetTextureFrame.width;
        this.uvs[3] = y;
        this.uvs[4] = x + destinationFrame.width / targetTextureFrame.width;
        this.uvs[5] = y + destinationFrame.height / targetTextureFrame.height;
        this.uvs[6] = x;
        this.uvs[7] = y + destinationFrame.height / targetTextureFrame.height;
        x = destinationFrame.x;
        y = destinationFrame.y;
        this.vertices[0] = x;
        this.vertices[1] = y;
        this.vertices[2] = x + destinationFrame.width;
        this.vertices[3] = y;
        this.vertices[4] = x + destinationFrame.width;
        this.vertices[5] = y + destinationFrame.height;
        this.vertices[6] = x;
        this.vertices[7] = y + destinationFrame.height;
        this.invalidate();
        return this;
      };
      QuadUv2.prototype.invalidate = function() {
        this.vertexBuffer._updateID++;
        this.uvBuffer._updateID++;
        return this;
      };
      return QuadUv2;
    })(Geometry)
  );
  var UID$2 = 0;
  var UniformGroup = (
    /** @class */
    (function() {
      function UniformGroup2(uniforms, isStatic, isUbo) {
        this.group = true;
        this.syncUniforms = {};
        this.dirtyId = 0;
        this.id = UID$2++;
        this.static = !!isStatic;
        this.ubo = !!isUbo;
        if (uniforms instanceof Buffer2) {
          this.buffer = uniforms;
          this.buffer.type = BUFFER_TYPE.UNIFORM_BUFFER;
          this.autoManage = false;
          this.ubo = true;
        } else {
          this.uniforms = uniforms;
          if (this.ubo) {
            this.buffer = new Buffer2(new Float32Array(1));
            this.buffer.type = BUFFER_TYPE.UNIFORM_BUFFER;
            this.autoManage = true;
          }
        }
      }
      UniformGroup2.prototype.update = function() {
        this.dirtyId++;
        if (!this.autoManage && this.buffer) {
          this.buffer.update();
        }
      };
      UniformGroup2.prototype.add = function(name, uniforms, _static) {
        if (!this.ubo) {
          this.uniforms[name] = new UniformGroup2(uniforms, _static);
        } else {
          throw new Error("[UniformGroup] uniform groups in ubo mode cannot be modified, or have uniform groups nested in them");
        }
      };
      UniformGroup2.from = function(uniforms, _static, _ubo) {
        return new UniformGroup2(uniforms, _static, _ubo);
      };
      UniformGroup2.uboFrom = function(uniforms, _static) {
        return new UniformGroup2(uniforms, _static !== null && _static !== void 0 ? _static : true, true);
      };
      return UniformGroup2;
    })()
  );
  var FilterState = (
    /** @class */
    (function() {
      function FilterState2() {
        this.renderTexture = null;
        this.target = null;
        this.legacy = false;
        this.resolution = 1;
        this.multisample = MSAA_QUALITY.NONE;
        this.sourceFrame = new Rectangle();
        this.destinationFrame = new Rectangle();
        this.bindingSourceFrame = new Rectangle();
        this.bindingDestinationFrame = new Rectangle();
        this.filters = [];
        this.transform = null;
      }
      FilterState2.prototype.clear = function() {
        this.target = null;
        this.filters = null;
        this.renderTexture = null;
      };
      return FilterState2;
    })()
  );
  var tempPoints2 = [new Point(), new Point(), new Point(), new Point()];
  var tempMatrix$2 = new Matrix();
  var FilterSystem = (
    /** @class */
    (function() {
      function FilterSystem2(renderer) {
        this.renderer = renderer;
        this.defaultFilterStack = [{}];
        this.texturePool = new RenderTexturePool();
        this.texturePool.setScreenSize(renderer.view);
        this.statePool = [];
        this.quad = new Quad();
        this.quadUv = new QuadUv();
        this.tempRect = new Rectangle();
        this.activeState = {};
        this.globalUniforms = new UniformGroup({
          outputFrame: new Rectangle(),
          inputSize: new Float32Array(4),
          inputPixel: new Float32Array(4),
          inputClamp: new Float32Array(4),
          resolution: 1,
          // legacy variables
          filterArea: new Float32Array(4),
          filterClamp: new Float32Array(4)
        }, true);
        this.forceClear = false;
        this.useMaxPadding = false;
      }
      FilterSystem2.prototype.push = function(target, filters) {
        var _a, _b;
        var renderer = this.renderer;
        var filterStack = this.defaultFilterStack;
        var state = this.statePool.pop() || new FilterState();
        var renderTextureSystem = this.renderer.renderTexture;
        var resolution = filters[0].resolution;
        var multisample = filters[0].multisample;
        var padding = filters[0].padding;
        var autoFit = filters[0].autoFit;
        var legacy = (_a = filters[0].legacy) !== null && _a !== void 0 ? _a : true;
        for (var i = 1; i < filters.length; i++) {
          var filter = filters[i];
          resolution = Math.min(resolution, filter.resolution);
          multisample = Math.min(multisample, filter.multisample);
          padding = this.useMaxPadding ? Math.max(padding, filter.padding) : padding + filter.padding;
          autoFit = autoFit && filter.autoFit;
          legacy = legacy || ((_b = filter.legacy) !== null && _b !== void 0 ? _b : true);
        }
        if (filterStack.length === 1) {
          this.defaultFilterStack[0].renderTexture = renderTextureSystem.current;
        }
        filterStack.push(state);
        state.resolution = resolution;
        state.multisample = multisample;
        state.legacy = legacy;
        state.target = target;
        state.sourceFrame.copyFrom(target.filterArea || target.getBounds(true));
        state.sourceFrame.pad(padding);
        var sourceFrameProjected = this.tempRect.copyFrom(renderTextureSystem.sourceFrame);
        if (renderer.projection.transform) {
          this.transformAABB(tempMatrix$2.copyFrom(renderer.projection.transform).invert(), sourceFrameProjected);
        }
        if (autoFit) {
          state.sourceFrame.fit(sourceFrameProjected);
          if (state.sourceFrame.width <= 0 || state.sourceFrame.height <= 0) {
            state.sourceFrame.width = 0;
            state.sourceFrame.height = 0;
          }
        } else if (!state.sourceFrame.intersects(sourceFrameProjected)) {
          state.sourceFrame.width = 0;
          state.sourceFrame.height = 0;
        }
        this.roundFrame(state.sourceFrame, renderTextureSystem.current ? renderTextureSystem.current.resolution : renderer.resolution, renderTextureSystem.sourceFrame, renderTextureSystem.destinationFrame, renderer.projection.transform);
        state.renderTexture = this.getOptimalFilterTexture(state.sourceFrame.width, state.sourceFrame.height, resolution, multisample);
        state.filters = filters;
        state.destinationFrame.width = state.renderTexture.width;
        state.destinationFrame.height = state.renderTexture.height;
        var destinationFrame = this.tempRect;
        destinationFrame.x = 0;
        destinationFrame.y = 0;
        destinationFrame.width = state.sourceFrame.width;
        destinationFrame.height = state.sourceFrame.height;
        state.renderTexture.filterFrame = state.sourceFrame;
        state.bindingSourceFrame.copyFrom(renderTextureSystem.sourceFrame);
        state.bindingDestinationFrame.copyFrom(renderTextureSystem.destinationFrame);
        state.transform = renderer.projection.transform;
        renderer.projection.transform = null;
        renderTextureSystem.bind(state.renderTexture, state.sourceFrame, destinationFrame);
        renderer.framebuffer.clear(0, 0, 0, 0);
      };
      FilterSystem2.prototype.pop = function() {
        var filterStack = this.defaultFilterStack;
        var state = filterStack.pop();
        var filters = state.filters;
        this.activeState = state;
        var globalUniforms = this.globalUniforms.uniforms;
        globalUniforms.outputFrame = state.sourceFrame;
        globalUniforms.resolution = state.resolution;
        var inputSize = globalUniforms.inputSize;
        var inputPixel = globalUniforms.inputPixel;
        var inputClamp = globalUniforms.inputClamp;
        inputSize[0] = state.destinationFrame.width;
        inputSize[1] = state.destinationFrame.height;
        inputSize[2] = 1 / inputSize[0];
        inputSize[3] = 1 / inputSize[1];
        inputPixel[0] = Math.round(inputSize[0] * state.resolution);
        inputPixel[1] = Math.round(inputSize[1] * state.resolution);
        inputPixel[2] = 1 / inputPixel[0];
        inputPixel[3] = 1 / inputPixel[1];
        inputClamp[0] = 0.5 * inputPixel[2];
        inputClamp[1] = 0.5 * inputPixel[3];
        inputClamp[2] = state.sourceFrame.width * inputSize[2] - 0.5 * inputPixel[2];
        inputClamp[3] = state.sourceFrame.height * inputSize[3] - 0.5 * inputPixel[3];
        if (state.legacy) {
          var filterArea = globalUniforms.filterArea;
          filterArea[0] = state.destinationFrame.width;
          filterArea[1] = state.destinationFrame.height;
          filterArea[2] = state.sourceFrame.x;
          filterArea[3] = state.sourceFrame.y;
          globalUniforms.filterClamp = globalUniforms.inputClamp;
        }
        this.globalUniforms.update();
        var lastState = filterStack[filterStack.length - 1];
        this.renderer.framebuffer.blit();
        if (filters.length === 1) {
          filters[0].apply(this, state.renderTexture, lastState.renderTexture, CLEAR_MODES.BLEND, state);
          this.returnFilterTexture(state.renderTexture);
        } else {
          var flip = state.renderTexture;
          var flop = this.getOptimalFilterTexture(flip.width, flip.height, state.resolution);
          flop.filterFrame = flip.filterFrame;
          var i = 0;
          for (i = 0; i < filters.length - 1; ++i) {
            if (i === 1 && state.multisample > 1) {
              flop = this.getOptimalFilterTexture(flip.width, flip.height, state.resolution);
              flop.filterFrame = flip.filterFrame;
            }
            filters[i].apply(this, flip, flop, CLEAR_MODES.CLEAR, state);
            var t = flip;
            flip = flop;
            flop = t;
          }
          filters[i].apply(this, flip, lastState.renderTexture, CLEAR_MODES.BLEND, state);
          if (i > 1 && state.multisample > 1) {
            this.returnFilterTexture(state.renderTexture);
          }
          this.returnFilterTexture(flip);
          this.returnFilterTexture(flop);
        }
        state.clear();
        this.statePool.push(state);
      };
      FilterSystem2.prototype.bindAndClear = function(filterTexture, clearMode) {
        if (clearMode === void 0) {
          clearMode = CLEAR_MODES.CLEAR;
        }
        var _a = this.renderer, renderTextureSystem = _a.renderTexture, stateSystem = _a.state;
        if (filterTexture === this.defaultFilterStack[this.defaultFilterStack.length - 1].renderTexture) {
          this.renderer.projection.transform = this.activeState.transform;
        } else {
          this.renderer.projection.transform = null;
        }
        if (filterTexture && filterTexture.filterFrame) {
          var destinationFrame = this.tempRect;
          destinationFrame.x = 0;
          destinationFrame.y = 0;
          destinationFrame.width = filterTexture.filterFrame.width;
          destinationFrame.height = filterTexture.filterFrame.height;
          renderTextureSystem.bind(filterTexture, filterTexture.filterFrame, destinationFrame);
        } else if (filterTexture !== this.defaultFilterStack[this.defaultFilterStack.length - 1].renderTexture) {
          renderTextureSystem.bind(filterTexture);
        } else {
          this.renderer.renderTexture.bind(filterTexture, this.activeState.bindingSourceFrame, this.activeState.bindingDestinationFrame);
        }
        var autoClear = stateSystem.stateId & 1 || this.forceClear;
        if (clearMode === CLEAR_MODES.CLEAR || clearMode === CLEAR_MODES.BLIT && autoClear) {
          this.renderer.framebuffer.clear(0, 0, 0, 0);
        }
      };
      FilterSystem2.prototype.applyFilter = function(filter, input, output, clearMode) {
        var renderer = this.renderer;
        renderer.state.set(filter.state);
        this.bindAndClear(output, clearMode);
        filter.uniforms.uSampler = input;
        filter.uniforms.filterGlobals = this.globalUniforms;
        renderer.shader.bind(filter);
        filter.legacy = !!filter.program.attributeData.aTextureCoord;
        if (filter.legacy) {
          this.quadUv.map(input._frame, input.filterFrame);
          renderer.geometry.bind(this.quadUv);
          renderer.geometry.draw(DRAW_MODES.TRIANGLES);
        } else {
          renderer.geometry.bind(this.quad);
          renderer.geometry.draw(DRAW_MODES.TRIANGLE_STRIP);
        }
      };
      FilterSystem2.prototype.calculateSpriteMatrix = function(outputMatrix, sprite) {
        var _a = this.activeState, sourceFrame = _a.sourceFrame, destinationFrame = _a.destinationFrame;
        var orig = sprite._texture.orig;
        var mappedMatrix = outputMatrix.set(destinationFrame.width, 0, 0, destinationFrame.height, sourceFrame.x, sourceFrame.y);
        var worldTransform = sprite.worldTransform.copyTo(Matrix.TEMP_MATRIX);
        worldTransform.invert();
        mappedMatrix.prepend(worldTransform);
        mappedMatrix.scale(1 / orig.width, 1 / orig.height);
        mappedMatrix.translate(sprite.anchor.x, sprite.anchor.y);
        return mappedMatrix;
      };
      FilterSystem2.prototype.destroy = function() {
        this.renderer = null;
        this.texturePool.clear(false);
      };
      FilterSystem2.prototype.getOptimalFilterTexture = function(minWidth, minHeight, resolution, multisample) {
        if (resolution === void 0) {
          resolution = 1;
        }
        if (multisample === void 0) {
          multisample = MSAA_QUALITY.NONE;
        }
        return this.texturePool.getOptimalTexture(minWidth, minHeight, resolution, multisample);
      };
      FilterSystem2.prototype.getFilterTexture = function(input, resolution, multisample) {
        if (typeof input === "number") {
          var swap = input;
          input = resolution;
          resolution = swap;
        }
        input = input || this.activeState.renderTexture;
        var filterTexture = this.texturePool.getOptimalTexture(input.width, input.height, resolution || input.resolution, multisample || MSAA_QUALITY.NONE);
        filterTexture.filterFrame = input.filterFrame;
        return filterTexture;
      };
      FilterSystem2.prototype.returnFilterTexture = function(renderTexture) {
        this.texturePool.returnTexture(renderTexture);
      };
      FilterSystem2.prototype.emptyPool = function() {
        this.texturePool.clear(true);
      };
      FilterSystem2.prototype.resize = function() {
        this.texturePool.setScreenSize(this.renderer.view);
      };
      FilterSystem2.prototype.transformAABB = function(matrix, rect) {
        var lt = tempPoints2[0];
        var lb = tempPoints2[1];
        var rt = tempPoints2[2];
        var rb = tempPoints2[3];
        lt.set(rect.left, rect.top);
        lb.set(rect.left, rect.bottom);
        rt.set(rect.right, rect.top);
        rb.set(rect.right, rect.bottom);
        matrix.apply(lt, lt);
        matrix.apply(lb, lb);
        matrix.apply(rt, rt);
        matrix.apply(rb, rb);
        var x0 = Math.min(lt.x, lb.x, rt.x, rb.x);
        var y0 = Math.min(lt.y, lb.y, rt.y, rb.y);
        var x1 = Math.max(lt.x, lb.x, rt.x, rb.x);
        var y1 = Math.max(lt.y, lb.y, rt.y, rb.y);
        rect.x = x0;
        rect.y = y0;
        rect.width = x1 - x0;
        rect.height = y1 - y0;
      };
      FilterSystem2.prototype.roundFrame = function(frame, resolution, bindingSourceFrame, bindingDestinationFrame, transform) {
        if (frame.width <= 0 || frame.height <= 0 || bindingSourceFrame.width <= 0 || bindingSourceFrame.height <= 0) {
          return;
        }
        if (transform) {
          var a = transform.a, b = transform.b, c = transform.c, d = transform.d;
          if ((Math.abs(b) > 1e-4 || Math.abs(c) > 1e-4) && (Math.abs(a) > 1e-4 || Math.abs(d) > 1e-4)) {
            return;
          }
        }
        transform = transform ? tempMatrix$2.copyFrom(transform) : tempMatrix$2.identity();
        transform.translate(-bindingSourceFrame.x, -bindingSourceFrame.y).scale(bindingDestinationFrame.width / bindingSourceFrame.width, bindingDestinationFrame.height / bindingSourceFrame.height).translate(bindingDestinationFrame.x, bindingDestinationFrame.y);
        this.transformAABB(transform, frame);
        frame.ceil(resolution);
        this.transformAABB(transform.invert(), frame);
      };
      return FilterSystem2;
    })()
  );
  var ObjectRenderer = (
    /** @class */
    (function() {
      function ObjectRenderer2(renderer) {
        this.renderer = renderer;
      }
      ObjectRenderer2.prototype.flush = function() {
      };
      ObjectRenderer2.prototype.destroy = function() {
        this.renderer = null;
      };
      ObjectRenderer2.prototype.start = function() {
      };
      ObjectRenderer2.prototype.stop = function() {
        this.flush();
      };
      ObjectRenderer2.prototype.render = function(_object) {
      };
      return ObjectRenderer2;
    })()
  );
  var BatchSystem = (
    /** @class */
    (function() {
      function BatchSystem2(renderer) {
        this.renderer = renderer;
        this.emptyRenderer = new ObjectRenderer(renderer);
        this.currentRenderer = this.emptyRenderer;
      }
      BatchSystem2.prototype.setObjectRenderer = function(objectRenderer) {
        if (this.currentRenderer === objectRenderer) {
          return;
        }
        this.currentRenderer.stop();
        this.currentRenderer = objectRenderer;
        this.currentRenderer.start();
      };
      BatchSystem2.prototype.flush = function() {
        this.setObjectRenderer(this.emptyRenderer);
      };
      BatchSystem2.prototype.reset = function() {
        this.setObjectRenderer(this.emptyRenderer);
      };
      BatchSystem2.prototype.copyBoundTextures = function(arr, maxTextures) {
        var boundTextures = this.renderer.texture.boundTextures;
        for (var i = maxTextures - 1; i >= 0; --i) {
          arr[i] = boundTextures[i] || null;
          if (arr[i]) {
            arr[i]._batchLocation = i;
          }
        }
      };
      BatchSystem2.prototype.boundArray = function(texArray, boundTextures, batchId, maxTextures) {
        var elements = texArray.elements, ids = texArray.ids, count = texArray.count;
        var j = 0;
        for (var i = 0; i < count; i++) {
          var tex = elements[i];
          var loc = tex._batchLocation;
          if (loc >= 0 && loc < maxTextures && boundTextures[loc] === tex) {
            ids[i] = loc;
            continue;
          }
          while (j < maxTextures) {
            var bound = boundTextures[j];
            if (bound && bound._batchEnabled === batchId && bound._batchLocation === j) {
              j++;
              continue;
            }
            ids[i] = j;
            tex._batchLocation = j;
            boundTextures[j] = tex;
            break;
          }
        }
      };
      BatchSystem2.prototype.destroy = function() {
        this.renderer = null;
      };
      return BatchSystem2;
    })()
  );
  var CONTEXT_UID_COUNTER = 0;
  var ContextSystem = (
    /** @class */
    (function() {
      function ContextSystem2(renderer) {
        this.renderer = renderer;
        this.webGLVersion = 1;
        this.extensions = {};
        this.supports = {
          uint32Indices: false
        };
        this.handleContextLost = this.handleContextLost.bind(this);
        this.handleContextRestored = this.handleContextRestored.bind(this);
        renderer.view.addEventListener("webglcontextlost", this.handleContextLost, false);
        renderer.view.addEventListener("webglcontextrestored", this.handleContextRestored, false);
      }
      Object.defineProperty(ContextSystem2.prototype, "isLost", {
        /**
         * `true` if the context is lost
         * @readonly
         */
        get: function() {
          return !this.gl || this.gl.isContextLost();
        },
        enumerable: false,
        configurable: true
      });
      ContextSystem2.prototype.contextChange = function(gl) {
        this.gl = gl;
        this.renderer.gl = gl;
        this.renderer.CONTEXT_UID = CONTEXT_UID_COUNTER++;
      };
      ContextSystem2.prototype.initFromContext = function(gl) {
        this.gl = gl;
        this.validateContext(gl);
        this.renderer.gl = gl;
        this.renderer.CONTEXT_UID = CONTEXT_UID_COUNTER++;
        this.renderer.runners.contextChange.emit(gl);
      };
      ContextSystem2.prototype.initFromOptions = function(options) {
        var gl = this.createContext(this.renderer.view, options);
        this.initFromContext(gl);
      };
      ContextSystem2.prototype.createContext = function(canvas, options) {
        var gl;
        if (settings.PREFER_ENV >= ENV.WEBGL2) {
          gl = canvas.getContext("webgl2", options);
        }
        if (gl) {
          this.webGLVersion = 2;
        } else {
          this.webGLVersion = 1;
          gl = canvas.getContext("webgl", options) || canvas.getContext("experimental-webgl", options);
          if (!gl) {
            throw new Error("This browser does not support WebGL. Try using the canvas renderer");
          }
        }
        this.gl = gl;
        this.getExtensions();
        return this.gl;
      };
      ContextSystem2.prototype.getExtensions = function() {
        var gl = this.gl;
        var common = {
          loseContext: gl.getExtension("WEBGL_lose_context"),
          anisotropicFiltering: gl.getExtension("EXT_texture_filter_anisotropic"),
          floatTextureLinear: gl.getExtension("OES_texture_float_linear"),
          s3tc: gl.getExtension("WEBGL_compressed_texture_s3tc"),
          s3tc_sRGB: gl.getExtension("WEBGL_compressed_texture_s3tc_srgb"),
          etc: gl.getExtension("WEBGL_compressed_texture_etc"),
          etc1: gl.getExtension("WEBGL_compressed_texture_etc1"),
          pvrtc: gl.getExtension("WEBGL_compressed_texture_pvrtc") || gl.getExtension("WEBKIT_WEBGL_compressed_texture_pvrtc"),
          atc: gl.getExtension("WEBGL_compressed_texture_atc"),
          astc: gl.getExtension("WEBGL_compressed_texture_astc")
        };
        if (this.webGLVersion === 1) {
          Object.assign(this.extensions, common, {
            drawBuffers: gl.getExtension("WEBGL_draw_buffers"),
            depthTexture: gl.getExtension("WEBGL_depth_texture"),
            vertexArrayObject: gl.getExtension("OES_vertex_array_object") || gl.getExtension("MOZ_OES_vertex_array_object") || gl.getExtension("WEBKIT_OES_vertex_array_object"),
            uint32ElementIndex: gl.getExtension("OES_element_index_uint"),
            // Floats and half-floats
            floatTexture: gl.getExtension("OES_texture_float"),
            floatTextureLinear: gl.getExtension("OES_texture_float_linear"),
            textureHalfFloat: gl.getExtension("OES_texture_half_float"),
            textureHalfFloatLinear: gl.getExtension("OES_texture_half_float_linear")
          });
        } else if (this.webGLVersion === 2) {
          Object.assign(this.extensions, common, {
            // Floats and half-floats
            colorBufferFloat: gl.getExtension("EXT_color_buffer_float")
          });
        }
      };
      ContextSystem2.prototype.handleContextLost = function(event) {
        var _this = this;
        event.preventDefault();
        setTimeout(function() {
          if (_this.gl.isContextLost() && _this.extensions.loseContext) {
            _this.extensions.loseContext.restoreContext();
          }
        }, 0);
      };
      ContextSystem2.prototype.handleContextRestored = function() {
        this.renderer.runners.contextChange.emit(this.gl);
      };
      ContextSystem2.prototype.destroy = function() {
        var view = this.renderer.view;
        this.renderer = null;
        view.removeEventListener("webglcontextlost", this.handleContextLost);
        view.removeEventListener("webglcontextrestored", this.handleContextRestored);
        this.gl.useProgram(null);
        if (this.extensions.loseContext) {
          this.extensions.loseContext.loseContext();
        }
      };
      ContextSystem2.prototype.postrender = function() {
        if (this.renderer.renderingToScreen) {
          this.gl.flush();
        }
      };
      ContextSystem2.prototype.validateContext = function(gl) {
        var attributes = gl.getContextAttributes();
        var isWebGl2 = "WebGL2RenderingContext" in globalThis && gl instanceof globalThis.WebGL2RenderingContext;
        if (isWebGl2) {
          this.webGLVersion = 2;
        }
        if (attributes && !attributes.stencil) {
          console.warn("Provided WebGL context does not have a stencil buffer, masks may not render correctly");
        }
        var hasuint32 = isWebGl2 || !!gl.getExtension("OES_element_index_uint");
        this.supports.uint32Indices = hasuint32;
        if (!hasuint32) {
          console.warn("Provided WebGL context does not support 32 index buffer, complex graphics may not render correctly");
        }
      };
      return ContextSystem2;
    })()
  );
  var GLFramebuffer = (
    /** @class */
    /* @__PURE__ */ (function() {
      function GLFramebuffer2(framebuffer) {
        this.framebuffer = framebuffer;
        this.stencil = null;
        this.dirtyId = -1;
        this.dirtyFormat = -1;
        this.dirtySize = -1;
        this.multisample = MSAA_QUALITY.NONE;
        this.msaaBuffer = null;
        this.blitFramebuffer = null;
        this.mipLevel = 0;
      }
      return GLFramebuffer2;
    })()
  );
  var tempRectangle = new Rectangle();
  var FramebufferSystem = (
    /** @class */
    (function() {
      function FramebufferSystem2(renderer) {
        this.renderer = renderer;
        this.managedFramebuffers = [];
        this.unknownFramebuffer = new Framebuffer(10, 10);
        this.msaaSamples = null;
      }
      FramebufferSystem2.prototype.contextChange = function() {
        this.disposeAll(true);
        var gl = this.gl = this.renderer.gl;
        this.CONTEXT_UID = this.renderer.CONTEXT_UID;
        this.current = this.unknownFramebuffer;
        this.viewport = new Rectangle();
        this.hasMRT = true;
        this.writeDepthTexture = true;
        if (this.renderer.context.webGLVersion === 1) {
          var nativeDrawBuffersExtension_1 = this.renderer.context.extensions.drawBuffers;
          var nativeDepthTextureExtension = this.renderer.context.extensions.depthTexture;
          if (settings.PREFER_ENV === ENV.WEBGL_LEGACY) {
            nativeDrawBuffersExtension_1 = null;
            nativeDepthTextureExtension = null;
          }
          if (nativeDrawBuffersExtension_1) {
            gl.drawBuffers = function(activeTextures) {
              return nativeDrawBuffersExtension_1.drawBuffersWEBGL(activeTextures);
            };
          } else {
            this.hasMRT = false;
            gl.drawBuffers = function() {
            };
          }
          if (!nativeDepthTextureExtension) {
            this.writeDepthTexture = false;
          }
        } else {
          this.msaaSamples = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA8, gl.SAMPLES);
        }
      };
      FramebufferSystem2.prototype.bind = function(framebuffer, frame, mipLevel) {
        if (mipLevel === void 0) {
          mipLevel = 0;
        }
        var gl = this.gl;
        if (framebuffer) {
          var fbo = framebuffer.glFramebuffers[this.CONTEXT_UID] || this.initFramebuffer(framebuffer);
          if (this.current !== framebuffer) {
            this.current = framebuffer;
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.framebuffer);
          }
          if (fbo.mipLevel !== mipLevel) {
            framebuffer.dirtyId++;
            framebuffer.dirtyFormat++;
            fbo.mipLevel = mipLevel;
          }
          if (fbo.dirtyId !== framebuffer.dirtyId) {
            fbo.dirtyId = framebuffer.dirtyId;
            if (fbo.dirtyFormat !== framebuffer.dirtyFormat) {
              fbo.dirtyFormat = framebuffer.dirtyFormat;
              fbo.dirtySize = framebuffer.dirtySize;
              this.updateFramebuffer(framebuffer, mipLevel);
            } else if (fbo.dirtySize !== framebuffer.dirtySize) {
              fbo.dirtySize = framebuffer.dirtySize;
              this.resizeFramebuffer(framebuffer);
            }
          }
          for (var i = 0; i < framebuffer.colorTextures.length; i++) {
            var tex = framebuffer.colorTextures[i];
            this.renderer.texture.unbind(tex.parentTextureArray || tex);
          }
          if (framebuffer.depthTexture) {
            this.renderer.texture.unbind(framebuffer.depthTexture);
          }
          if (frame) {
            var mipWidth = frame.width >> mipLevel;
            var mipHeight = frame.height >> mipLevel;
            var scale = mipWidth / frame.width;
            this.setViewport(frame.x * scale, frame.y * scale, mipWidth, mipHeight);
          } else {
            var mipWidth = framebuffer.width >> mipLevel;
            var mipHeight = framebuffer.height >> mipLevel;
            this.setViewport(0, 0, mipWidth, mipHeight);
          }
        } else {
          if (this.current) {
            this.current = null;
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          }
          if (frame) {
            this.setViewport(frame.x, frame.y, frame.width, frame.height);
          } else {
            this.setViewport(0, 0, this.renderer.width, this.renderer.height);
          }
        }
      };
      FramebufferSystem2.prototype.setViewport = function(x, y, width, height) {
        var v = this.viewport;
        x = Math.round(x);
        y = Math.round(y);
        width = Math.round(width);
        height = Math.round(height);
        if (v.width !== width || v.height !== height || v.x !== x || v.y !== y) {
          v.x = x;
          v.y = y;
          v.width = width;
          v.height = height;
          this.gl.viewport(x, y, width, height);
        }
      };
      Object.defineProperty(FramebufferSystem2.prototype, "size", {
        /**
         * Get the size of the current width and height. Returns object with `width` and `height` values.
         * @readonly
         */
        get: function() {
          if (this.current) {
            return { x: 0, y: 0, width: this.current.width, height: this.current.height };
          }
          return { x: 0, y: 0, width: this.renderer.width, height: this.renderer.height };
        },
        enumerable: false,
        configurable: true
      });
      FramebufferSystem2.prototype.clear = function(r, g, b, a, mask) {
        if (mask === void 0) {
          mask = BUFFER_BITS.COLOR | BUFFER_BITS.DEPTH;
        }
        var gl = this.gl;
        gl.clearColor(r, g, b, a);
        gl.clear(mask);
      };
      FramebufferSystem2.prototype.initFramebuffer = function(framebuffer) {
        var gl = this.gl;
        var fbo = new GLFramebuffer(gl.createFramebuffer());
        fbo.multisample = this.detectSamples(framebuffer.multisample);
        framebuffer.glFramebuffers[this.CONTEXT_UID] = fbo;
        this.managedFramebuffers.push(framebuffer);
        framebuffer.disposeRunner.add(this);
        return fbo;
      };
      FramebufferSystem2.prototype.resizeFramebuffer = function(framebuffer) {
        var gl = this.gl;
        var fbo = framebuffer.glFramebuffers[this.CONTEXT_UID];
        if (fbo.msaaBuffer) {
          gl.bindRenderbuffer(gl.RENDERBUFFER, fbo.msaaBuffer);
          gl.renderbufferStorageMultisample(gl.RENDERBUFFER, fbo.multisample, gl.RGBA8, framebuffer.width, framebuffer.height);
        }
        if (fbo.stencil) {
          gl.bindRenderbuffer(gl.RENDERBUFFER, fbo.stencil);
          if (fbo.msaaBuffer) {
            gl.renderbufferStorageMultisample(gl.RENDERBUFFER, fbo.multisample, gl.DEPTH24_STENCIL8, framebuffer.width, framebuffer.height);
          } else {
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_STENCIL, framebuffer.width, framebuffer.height);
          }
        }
        var colorTextures = framebuffer.colorTextures;
        var count = colorTextures.length;
        if (!gl.drawBuffers) {
          count = Math.min(count, 1);
        }
        for (var i = 0; i < count; i++) {
          var texture = colorTextures[i];
          var parentTexture = texture.parentTextureArray || texture;
          this.renderer.texture.bind(parentTexture, 0);
        }
        if (framebuffer.depthTexture && this.writeDepthTexture) {
          this.renderer.texture.bind(framebuffer.depthTexture, 0);
        }
      };
      FramebufferSystem2.prototype.updateFramebuffer = function(framebuffer, mipLevel) {
        var gl = this.gl;
        var fbo = framebuffer.glFramebuffers[this.CONTEXT_UID];
        var colorTextures = framebuffer.colorTextures;
        var count = colorTextures.length;
        if (!gl.drawBuffers) {
          count = Math.min(count, 1);
        }
        if (fbo.multisample > 1 && this.canMultisampleFramebuffer(framebuffer)) {
          fbo.msaaBuffer = fbo.msaaBuffer || gl.createRenderbuffer();
          gl.bindRenderbuffer(gl.RENDERBUFFER, fbo.msaaBuffer);
          gl.renderbufferStorageMultisample(gl.RENDERBUFFER, fbo.multisample, gl.RGBA8, framebuffer.width, framebuffer.height);
          gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, fbo.msaaBuffer);
        } else if (fbo.msaaBuffer) {
          gl.deleteRenderbuffer(fbo.msaaBuffer);
          fbo.msaaBuffer = null;
          if (fbo.blitFramebuffer) {
            fbo.blitFramebuffer.dispose();
            fbo.blitFramebuffer = null;
          }
        }
        var activeTextures = [];
        for (var i = 0; i < count; i++) {
          var texture = colorTextures[i];
          var parentTexture = texture.parentTextureArray || texture;
          this.renderer.texture.bind(parentTexture, 0);
          if (i === 0 && fbo.msaaBuffer) {
            continue;
          }
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, texture.target, parentTexture._glTextures[this.CONTEXT_UID].texture, mipLevel);
          activeTextures.push(gl.COLOR_ATTACHMENT0 + i);
        }
        if (activeTextures.length > 1) {
          gl.drawBuffers(activeTextures);
        }
        if (framebuffer.depthTexture) {
          var writeDepthTexture = this.writeDepthTexture;
          if (writeDepthTexture) {
            var depthTexture = framebuffer.depthTexture;
            this.renderer.texture.bind(depthTexture, 0);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTexture._glTextures[this.CONTEXT_UID].texture, mipLevel);
          }
        }
        if ((framebuffer.stencil || framebuffer.depth) && !(framebuffer.depthTexture && this.writeDepthTexture)) {
          fbo.stencil = fbo.stencil || gl.createRenderbuffer();
          gl.bindRenderbuffer(gl.RENDERBUFFER, fbo.stencil);
          if (fbo.msaaBuffer) {
            gl.renderbufferStorageMultisample(gl.RENDERBUFFER, fbo.multisample, gl.DEPTH24_STENCIL8, framebuffer.width, framebuffer.height);
          } else {
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_STENCIL, framebuffer.width, framebuffer.height);
          }
          gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, fbo.stencil);
        } else if (fbo.stencil) {
          gl.deleteRenderbuffer(fbo.stencil);
          fbo.stencil = null;
        }
      };
      FramebufferSystem2.prototype.canMultisampleFramebuffer = function(framebuffer) {
        return this.renderer.context.webGLVersion !== 1 && framebuffer.colorTextures.length <= 1 && !framebuffer.depthTexture;
      };
      FramebufferSystem2.prototype.detectSamples = function(samples) {
        var msaaSamples = this.msaaSamples;
        var res = MSAA_QUALITY.NONE;
        if (samples <= 1 || msaaSamples === null) {
          return res;
        }
        for (var i = 0; i < msaaSamples.length; i++) {
          if (msaaSamples[i] <= samples) {
            res = msaaSamples[i];
            break;
          }
        }
        if (res === 1) {
          res = MSAA_QUALITY.NONE;
        }
        return res;
      };
      FramebufferSystem2.prototype.blit = function(framebuffer, sourcePixels, destPixels) {
        var _a = this, current = _a.current, renderer = _a.renderer, gl = _a.gl, CONTEXT_UID = _a.CONTEXT_UID;
        if (renderer.context.webGLVersion !== 2) {
          return;
        }
        if (!current) {
          return;
        }
        var fbo = current.glFramebuffers[CONTEXT_UID];
        if (!fbo) {
          return;
        }
        if (!framebuffer) {
          if (!fbo.msaaBuffer) {
            return;
          }
          var colorTexture = current.colorTextures[0];
          if (!colorTexture) {
            return;
          }
          if (!fbo.blitFramebuffer) {
            fbo.blitFramebuffer = new Framebuffer(current.width, current.height);
            fbo.blitFramebuffer.addColorTexture(0, colorTexture);
          }
          framebuffer = fbo.blitFramebuffer;
          if (framebuffer.colorTextures[0] !== colorTexture) {
            framebuffer.colorTextures[0] = colorTexture;
            framebuffer.dirtyId++;
            framebuffer.dirtyFormat++;
          }
          if (framebuffer.width !== current.width || framebuffer.height !== current.height) {
            framebuffer.width = current.width;
            framebuffer.height = current.height;
            framebuffer.dirtyId++;
            framebuffer.dirtySize++;
          }
        }
        if (!sourcePixels) {
          sourcePixels = tempRectangle;
          sourcePixels.width = current.width;
          sourcePixels.height = current.height;
        }
        if (!destPixels) {
          destPixels = sourcePixels;
        }
        var sameSize = sourcePixels.width === destPixels.width && sourcePixels.height === destPixels.height;
        this.bind(framebuffer);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo.framebuffer);
        gl.blitFramebuffer(sourcePixels.left, sourcePixels.top, sourcePixels.right, sourcePixels.bottom, destPixels.left, destPixels.top, destPixels.right, destPixels.bottom, gl.COLOR_BUFFER_BIT, sameSize ? gl.NEAREST : gl.LINEAR);
      };
      FramebufferSystem2.prototype.disposeFramebuffer = function(framebuffer, contextLost) {
        var fbo = framebuffer.glFramebuffers[this.CONTEXT_UID];
        var gl = this.gl;
        if (!fbo) {
          return;
        }
        delete framebuffer.glFramebuffers[this.CONTEXT_UID];
        var index = this.managedFramebuffers.indexOf(framebuffer);
        if (index >= 0) {
          this.managedFramebuffers.splice(index, 1);
        }
        framebuffer.disposeRunner.remove(this);
        if (!contextLost) {
          gl.deleteFramebuffer(fbo.framebuffer);
          if (fbo.msaaBuffer) {
            gl.deleteRenderbuffer(fbo.msaaBuffer);
          }
          if (fbo.stencil) {
            gl.deleteRenderbuffer(fbo.stencil);
          }
        }
        if (fbo.blitFramebuffer) {
          fbo.blitFramebuffer.dispose();
        }
      };
      FramebufferSystem2.prototype.disposeAll = function(contextLost) {
        var list = this.managedFramebuffers;
        this.managedFramebuffers = [];
        for (var i = 0; i < list.length; i++) {
          this.disposeFramebuffer(list[i], contextLost);
        }
      };
      FramebufferSystem2.prototype.forceStencil = function() {
        var framebuffer = this.current;
        if (!framebuffer) {
          return;
        }
        var fbo = framebuffer.glFramebuffers[this.CONTEXT_UID];
        if (!fbo || fbo.stencil) {
          return;
        }
        framebuffer.stencil = true;
        var w = framebuffer.width;
        var h = framebuffer.height;
        var gl = this.gl;
        var stencil = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, stencil);
        if (fbo.msaaBuffer) {
          gl.renderbufferStorageMultisample(gl.RENDERBUFFER, fbo.multisample, gl.DEPTH24_STENCIL8, w, h);
        } else {
          gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_STENCIL, w, h);
        }
        fbo.stencil = stencil;
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, stencil);
      };
      FramebufferSystem2.prototype.reset = function() {
        this.current = this.unknownFramebuffer;
        this.viewport = new Rectangle();
      };
      FramebufferSystem2.prototype.destroy = function() {
        this.renderer = null;
      };
      return FramebufferSystem2;
    })()
  );
  var byteSizeMap = { 5126: 4, 5123: 2, 5121: 1 };
  var GeometrySystem = (
    /** @class */
    (function() {
      function GeometrySystem2(renderer) {
        this.renderer = renderer;
        this._activeGeometry = null;
        this._activeVao = null;
        this.hasVao = true;
        this.hasInstance = true;
        this.canUseUInt32ElementIndex = false;
        this.managedGeometries = {};
      }
      GeometrySystem2.prototype.contextChange = function() {
        this.disposeAll(true);
        var gl = this.gl = this.renderer.gl;
        var context2 = this.renderer.context;
        this.CONTEXT_UID = this.renderer.CONTEXT_UID;
        if (context2.webGLVersion !== 2) {
          var nativeVaoExtension_1 = this.renderer.context.extensions.vertexArrayObject;
          if (settings.PREFER_ENV === ENV.WEBGL_LEGACY) {
            nativeVaoExtension_1 = null;
          }
          if (nativeVaoExtension_1) {
            gl.createVertexArray = function() {
              return nativeVaoExtension_1.createVertexArrayOES();
            };
            gl.bindVertexArray = function(vao) {
              return nativeVaoExtension_1.bindVertexArrayOES(vao);
            };
            gl.deleteVertexArray = function(vao) {
              return nativeVaoExtension_1.deleteVertexArrayOES(vao);
            };
          } else {
            this.hasVao = false;
            gl.createVertexArray = function() {
              return null;
            };
            gl.bindVertexArray = function() {
              return null;
            };
            gl.deleteVertexArray = function() {
              return null;
            };
          }
        }
        if (context2.webGLVersion !== 2) {
          var instanceExt_1 = gl.getExtension("ANGLE_instanced_arrays");
          if (instanceExt_1) {
            gl.vertexAttribDivisor = function(a, b) {
              return instanceExt_1.vertexAttribDivisorANGLE(a, b);
            };
            gl.drawElementsInstanced = function(a, b, c, d, e) {
              return instanceExt_1.drawElementsInstancedANGLE(a, b, c, d, e);
            };
            gl.drawArraysInstanced = function(a, b, c, d) {
              return instanceExt_1.drawArraysInstancedANGLE(a, b, c, d);
            };
          } else {
            this.hasInstance = false;
          }
        }
        this.canUseUInt32ElementIndex = context2.webGLVersion === 2 || !!context2.extensions.uint32ElementIndex;
      };
      GeometrySystem2.prototype.bind = function(geometry, shader) {
        shader = shader || this.renderer.shader.shader;
        var gl = this.gl;
        var vaos = geometry.glVertexArrayObjects[this.CONTEXT_UID];
        var incRefCount = false;
        if (!vaos) {
          this.managedGeometries[geometry.id] = geometry;
          geometry.disposeRunner.add(this);
          geometry.glVertexArrayObjects[this.CONTEXT_UID] = vaos = {};
          incRefCount = true;
        }
        var vao = vaos[shader.program.id] || this.initGeometryVao(geometry, shader, incRefCount);
        this._activeGeometry = geometry;
        if (this._activeVao !== vao) {
          this._activeVao = vao;
          if (this.hasVao) {
            gl.bindVertexArray(vao);
          } else {
            this.activateVao(geometry, shader.program);
          }
        }
        this.updateBuffers();
      };
      GeometrySystem2.prototype.reset = function() {
        this.unbind();
      };
      GeometrySystem2.prototype.updateBuffers = function() {
        var geometry = this._activeGeometry;
        var bufferSystem = this.renderer.buffer;
        for (var i = 0; i < geometry.buffers.length; i++) {
          var buffer = geometry.buffers[i];
          bufferSystem.update(buffer);
        }
      };
      GeometrySystem2.prototype.checkCompatibility = function(geometry, program) {
        var geometryAttributes = geometry.attributes;
        var shaderAttributes = program.attributeData;
        for (var j in shaderAttributes) {
          if (!geometryAttributes[j]) {
            throw new Error('shader and geometry incompatible, geometry missing the "' + j + '" attribute');
          }
        }
      };
      GeometrySystem2.prototype.getSignature = function(geometry, program) {
        var attribs = geometry.attributes;
        var shaderAttributes = program.attributeData;
        var strings = ["g", geometry.id];
        for (var i in attribs) {
          if (shaderAttributes[i]) {
            strings.push(i, shaderAttributes[i].location);
          }
        }
        return strings.join("-");
      };
      GeometrySystem2.prototype.initGeometryVao = function(geometry, shader, incRefCount) {
        if (incRefCount === void 0) {
          incRefCount = true;
        }
        var gl = this.gl;
        var CONTEXT_UID = this.CONTEXT_UID;
        var bufferSystem = this.renderer.buffer;
        var program = shader.program;
        if (!program.glPrograms[CONTEXT_UID]) {
          this.renderer.shader.generateProgram(shader);
        }
        this.checkCompatibility(geometry, program);
        var signature = this.getSignature(geometry, program);
        var vaoObjectHash = geometry.glVertexArrayObjects[this.CONTEXT_UID];
        var vao = vaoObjectHash[signature];
        if (vao) {
          vaoObjectHash[program.id] = vao;
          return vao;
        }
        var buffers = geometry.buffers;
        var attributes = geometry.attributes;
        var tempStride = {};
        var tempStart = {};
        for (var j in buffers) {
          tempStride[j] = 0;
          tempStart[j] = 0;
        }
        for (var j in attributes) {
          if (!attributes[j].size && program.attributeData[j]) {
            attributes[j].size = program.attributeData[j].size;
          } else if (!attributes[j].size) {
            console.warn("PIXI Geometry attribute '" + j + "' size cannot be determined (likely the bound shader does not have the attribute)");
          }
          tempStride[attributes[j].buffer] += attributes[j].size * byteSizeMap[attributes[j].type];
        }
        for (var j in attributes) {
          var attribute = attributes[j];
          var attribSize = attribute.size;
          if (attribute.stride === void 0) {
            if (tempStride[attribute.buffer] === attribSize * byteSizeMap[attribute.type]) {
              attribute.stride = 0;
            } else {
              attribute.stride = tempStride[attribute.buffer];
            }
          }
          if (attribute.start === void 0) {
            attribute.start = tempStart[attribute.buffer];
            tempStart[attribute.buffer] += attribSize * byteSizeMap[attribute.type];
          }
        }
        vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        for (var i = 0; i < buffers.length; i++) {
          var buffer = buffers[i];
          bufferSystem.bind(buffer);
          if (incRefCount) {
            buffer._glBuffers[CONTEXT_UID].refCount++;
          }
        }
        this.activateVao(geometry, program);
        this._activeVao = vao;
        vaoObjectHash[program.id] = vao;
        vaoObjectHash[signature] = vao;
        return vao;
      };
      GeometrySystem2.prototype.disposeGeometry = function(geometry, contextLost) {
        var _a;
        if (!this.managedGeometries[geometry.id]) {
          return;
        }
        delete this.managedGeometries[geometry.id];
        var vaos = geometry.glVertexArrayObjects[this.CONTEXT_UID];
        var gl = this.gl;
        var buffers = geometry.buffers;
        var bufferSystem = (_a = this.renderer) === null || _a === void 0 ? void 0 : _a.buffer;
        geometry.disposeRunner.remove(this);
        if (!vaos) {
          return;
        }
        if (bufferSystem) {
          for (var i = 0; i < buffers.length; i++) {
            var buf = buffers[i]._glBuffers[this.CONTEXT_UID];
            if (buf) {
              buf.refCount--;
              if (buf.refCount === 0 && !contextLost) {
                bufferSystem.dispose(buffers[i], contextLost);
              }
            }
          }
        }
        if (!contextLost) {
          for (var vaoId in vaos) {
            if (vaoId[0] === "g") {
              var vao = vaos[vaoId];
              if (this._activeVao === vao) {
                this.unbind();
              }
              gl.deleteVertexArray(vao);
            }
          }
        }
        delete geometry.glVertexArrayObjects[this.CONTEXT_UID];
      };
      GeometrySystem2.prototype.disposeAll = function(contextLost) {
        var all = Object.keys(this.managedGeometries);
        for (var i = 0; i < all.length; i++) {
          this.disposeGeometry(this.managedGeometries[all[i]], contextLost);
        }
      };
      GeometrySystem2.prototype.activateVao = function(geometry, program) {
        var gl = this.gl;
        var CONTEXT_UID = this.CONTEXT_UID;
        var bufferSystem = this.renderer.buffer;
        var buffers = geometry.buffers;
        var attributes = geometry.attributes;
        if (geometry.indexBuffer) {
          bufferSystem.bind(geometry.indexBuffer);
        }
        var lastBuffer = null;
        for (var j in attributes) {
          var attribute = attributes[j];
          var buffer = buffers[attribute.buffer];
          var glBuffer = buffer._glBuffers[CONTEXT_UID];
          if (program.attributeData[j]) {
            if (lastBuffer !== glBuffer) {
              bufferSystem.bind(buffer);
              lastBuffer = glBuffer;
            }
            var location = program.attributeData[j].location;
            gl.enableVertexAttribArray(location);
            gl.vertexAttribPointer(location, attribute.size, attribute.type || gl.FLOAT, attribute.normalized, attribute.stride, attribute.start);
            if (attribute.instance) {
              if (this.hasInstance) {
                gl.vertexAttribDivisor(location, 1);
              } else {
                throw new Error("geometry error, GPU Instancing is not supported on this device");
              }
            }
          }
        }
      };
      GeometrySystem2.prototype.draw = function(type, size, start, instanceCount) {
        var gl = this.gl;
        var geometry = this._activeGeometry;
        if (geometry.indexBuffer) {
          var byteSize = geometry.indexBuffer.data.BYTES_PER_ELEMENT;
          var glType = byteSize === 2 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
          if (byteSize === 2 || byteSize === 4 && this.canUseUInt32ElementIndex) {
            if (geometry.instanced) {
              gl.drawElementsInstanced(type, size || geometry.indexBuffer.data.length, glType, (start || 0) * byteSize, instanceCount || 1);
            } else {
              gl.drawElements(type, size || geometry.indexBuffer.data.length, glType, (start || 0) * byteSize);
            }
          } else {
            console.warn("unsupported index buffer type: uint32");
          }
        } else if (geometry.instanced) {
          gl.drawArraysInstanced(type, start, size || geometry.getSize(), instanceCount || 1);
        } else {
          gl.drawArrays(type, start, size || geometry.getSize());
        }
        return this;
      };
      GeometrySystem2.prototype.unbind = function() {
        this.gl.bindVertexArray(null);
        this._activeVao = null;
        this._activeGeometry = null;
      };
      GeometrySystem2.prototype.destroy = function() {
        this.renderer = null;
      };
      return GeometrySystem2;
    })()
  );
  var MaskData = (
    /** @class */
    (function() {
      function MaskData2(maskObject) {
        if (maskObject === void 0) {
          maskObject = null;
        }
        this.type = MASK_TYPES.NONE;
        this.autoDetect = true;
        this.maskObject = maskObject || null;
        this.pooled = false;
        this.isMaskData = true;
        this.resolution = null;
        this.multisample = settings.FILTER_MULTISAMPLE;
        this.enabled = true;
        this.colorMask = 15;
        this._filters = null;
        this._stencilCounter = 0;
        this._scissorCounter = 0;
        this._scissorRect = null;
        this._scissorRectLocal = null;
        this._colorMask = 15;
        this._target = null;
      }
      Object.defineProperty(MaskData2.prototype, "filter", {
        /**
         * The sprite mask filter.
         * If set to `null`, the default sprite mask filter is used.
         * @default null
         */
        get: function() {
          return this._filters ? this._filters[0] : null;
        },
        set: function(value) {
          if (value) {
            if (this._filters) {
              this._filters[0] = value;
            } else {
              this._filters = [value];
            }
          } else {
            this._filters = null;
          }
        },
        enumerable: false,
        configurable: true
      });
      MaskData2.prototype.reset = function() {
        if (this.pooled) {
          this.maskObject = null;
          this.type = MASK_TYPES.NONE;
          this.autoDetect = true;
        }
        this._target = null;
        this._scissorRectLocal = null;
      };
      MaskData2.prototype.copyCountersOrReset = function(maskAbove) {
        if (maskAbove) {
          this._stencilCounter = maskAbove._stencilCounter;
          this._scissorCounter = maskAbove._scissorCounter;
          this._scissorRect = maskAbove._scissorRect;
        } else {
          this._stencilCounter = 0;
          this._scissorCounter = 0;
          this._scissorRect = null;
        }
      };
      return MaskData2;
    })()
  );
  function compileShader(gl, type, src) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    return shader;
  }
  function logPrettyShaderError(gl, shader) {
    var shaderSrc = gl.getShaderSource(shader).split("\n").map(function(line, index) {
      return index + ": " + line;
    });
    var shaderLog = gl.getShaderInfoLog(shader);
    var splitShader = shaderLog.split("\n");
    var dedupe = {};
    var lineNumbers = splitShader.map(function(line) {
      return parseFloat(line.replace(/^ERROR\: 0\:([\d]+)\:.*$/, "$1"));
    }).filter(function(n) {
      if (n && !dedupe[n]) {
        dedupe[n] = true;
        return true;
      }
      return false;
    });
    var logArgs = [""];
    lineNumbers.forEach(function(number) {
      shaderSrc[number - 1] = "%c" + shaderSrc[number - 1] + "%c";
      logArgs.push("background: #FF0000; color:#FFFFFF; font-size: 10px", "font-size: 10px");
    });
    var fragmentSourceToLog = shaderSrc.join("\n");
    logArgs[0] = fragmentSourceToLog;
    console.error(shaderLog);
    console.groupCollapsed("click to view full shader code");
    console.warn.apply(console, logArgs);
    console.groupEnd();
  }
  function logProgramError(gl, program, vertexShader, fragmentShader) {
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
        logPrettyShaderError(gl, vertexShader);
      }
      if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
        logPrettyShaderError(gl, fragmentShader);
      }
      console.error("PixiJS Error: Could not initialize shader.");
      if (gl.getProgramInfoLog(program) !== "") {
        console.warn("PixiJS Warning: gl.getProgramInfoLog()", gl.getProgramInfoLog(program));
      }
    }
  }
  function booleanArray(size) {
    var array = new Array(size);
    for (var i = 0; i < array.length; i++) {
      array[i] = false;
    }
    return array;
  }
  function defaultValue(type, size) {
    switch (type) {
      case "float":
        return 0;
      case "vec2":
        return new Float32Array(2 * size);
      case "vec3":
        return new Float32Array(3 * size);
      case "vec4":
        return new Float32Array(4 * size);
      case "int":
      case "uint":
      case "sampler2D":
      case "sampler2DArray":
        return 0;
      case "ivec2":
        return new Int32Array(2 * size);
      case "ivec3":
        return new Int32Array(3 * size);
      case "ivec4":
        return new Int32Array(4 * size);
      case "uvec2":
        return new Uint32Array(2 * size);
      case "uvec3":
        return new Uint32Array(3 * size);
      case "uvec4":
        return new Uint32Array(4 * size);
      case "bool":
        return false;
      case "bvec2":
        return booleanArray(2 * size);
      case "bvec3":
        return booleanArray(3 * size);
      case "bvec4":
        return booleanArray(4 * size);
      case "mat2":
        return new Float32Array([
          1,
          0,
          0,
          1
        ]);
      case "mat3":
        return new Float32Array([
          1,
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          1
        ]);
      case "mat4":
        return new Float32Array([
          1,
          0,
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          0,
          1
        ]);
    }
    return null;
  }
  var unknownContext = {};
  var context = unknownContext;
  function getTestContext() {
    if (context === unknownContext || context && context.isContextLost()) {
      var canvas = settings.ADAPTER.createCanvas();
      var gl = void 0;
      if (settings.PREFER_ENV >= ENV.WEBGL2) {
        gl = canvas.getContext("webgl2", {});
      }
      if (!gl) {
        gl = canvas.getContext("webgl", {}) || canvas.getContext("experimental-webgl", {});
        if (!gl) {
          gl = null;
        } else {
          gl.getExtension("WEBGL_draw_buffers");
        }
      }
      context = gl;
    }
    return context;
  }
  var maxFragmentPrecision;
  function getMaxFragmentPrecision() {
    if (!maxFragmentPrecision) {
      maxFragmentPrecision = PRECISION.MEDIUM;
      var gl = getTestContext();
      if (gl) {
        if (gl.getShaderPrecisionFormat) {
          var shaderFragment = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
          maxFragmentPrecision = shaderFragment.precision ? PRECISION.HIGH : PRECISION.MEDIUM;
        }
      }
    }
    return maxFragmentPrecision;
  }
  function setPrecision(src, requestedPrecision, maxSupportedPrecision) {
    if (src.substring(0, 9) !== "precision") {
      var precision = requestedPrecision;
      if (requestedPrecision === PRECISION.HIGH && maxSupportedPrecision !== PRECISION.HIGH) {
        precision = PRECISION.MEDIUM;
      }
      return "precision " + precision + " float;\n" + src;
    } else if (maxSupportedPrecision !== PRECISION.HIGH && src.substring(0, 15) === "precision highp") {
      return src.replace("precision highp", "precision mediump");
    }
    return src;
  }
  var GLSL_TO_SIZE = {
    float: 1,
    vec2: 2,
    vec3: 3,
    vec4: 4,
    int: 1,
    ivec2: 2,
    ivec3: 3,
    ivec4: 4,
    uint: 1,
    uvec2: 2,
    uvec3: 3,
    uvec4: 4,
    bool: 1,
    bvec2: 2,
    bvec3: 3,
    bvec4: 4,
    mat2: 4,
    mat3: 9,
    mat4: 16,
    sampler2D: 1
  };
  function mapSize(type) {
    return GLSL_TO_SIZE[type];
  }
  var GL_TABLE = null;
  var GL_TO_GLSL_TYPES = {
    FLOAT: "float",
    FLOAT_VEC2: "vec2",
    FLOAT_VEC3: "vec3",
    FLOAT_VEC4: "vec4",
    INT: "int",
    INT_VEC2: "ivec2",
    INT_VEC3: "ivec3",
    INT_VEC4: "ivec4",
    UNSIGNED_INT: "uint",
    UNSIGNED_INT_VEC2: "uvec2",
    UNSIGNED_INT_VEC3: "uvec3",
    UNSIGNED_INT_VEC4: "uvec4",
    BOOL: "bool",
    BOOL_VEC2: "bvec2",
    BOOL_VEC3: "bvec3",
    BOOL_VEC4: "bvec4",
    FLOAT_MAT2: "mat2",
    FLOAT_MAT3: "mat3",
    FLOAT_MAT4: "mat4",
    SAMPLER_2D: "sampler2D",
    INT_SAMPLER_2D: "sampler2D",
    UNSIGNED_INT_SAMPLER_2D: "sampler2D",
    SAMPLER_CUBE: "samplerCube",
    INT_SAMPLER_CUBE: "samplerCube",
    UNSIGNED_INT_SAMPLER_CUBE: "samplerCube",
    SAMPLER_2D_ARRAY: "sampler2DArray",
    INT_SAMPLER_2D_ARRAY: "sampler2DArray",
    UNSIGNED_INT_SAMPLER_2D_ARRAY: "sampler2DArray"
  };
  function mapType(gl, type) {
    if (!GL_TABLE) {
      var typeNames = Object.keys(GL_TO_GLSL_TYPES);
      GL_TABLE = {};
      for (var i = 0; i < typeNames.length; ++i) {
        var tn = typeNames[i];
        GL_TABLE[gl[tn]] = GL_TO_GLSL_TYPES[tn];
      }
    }
    return GL_TABLE[type];
  }
  var uniformParsers = [
    // a float cache layer
    {
      test: function(data) {
        return data.type === "float" && data.size === 1 && !data.isArray;
      },
      code: function(name) {
        return '\n            if(uv["' + name + '"] !== ud["' + name + '"].value)\n            {\n                ud["' + name + '"].value = uv["' + name + '"]\n                gl.uniform1f(ud["' + name + '"].location, uv["' + name + '"])\n            }\n            ';
      }
    },
    // handling samplers
    {
      test: function(data, uniform) {
        return (data.type === "sampler2D" || data.type === "samplerCube" || data.type === "sampler2DArray") && data.size === 1 && !data.isArray && (uniform == null || uniform.castToBaseTexture !== void 0);
      },
      code: function(name) {
        return 't = syncData.textureCount++;\n\n            renderer.texture.bind(uv["' + name + '"], t);\n\n            if(ud["' + name + '"].value !== t)\n            {\n                ud["' + name + '"].value = t;\n                gl.uniform1i(ud["' + name + '"].location, t);\n; // eslint-disable-line max-len\n            }';
      }
    },
    // uploading pixi matrix object to mat3
    {
      test: function(data, uniform) {
        return data.type === "mat3" && data.size === 1 && !data.isArray && uniform.a !== void 0;
      },
      code: function(name) {
        return '\n            gl.uniformMatrix3fv(ud["' + name + '"].location, false, uv["' + name + '"].toArray(true));\n            ';
      },
      codeUbo: function(name) {
        return "\n                var " + name + "_matrix = uv." + name + ".toArray(true);\n\n                data[offset] = " + name + "_matrix[0];\n                data[offset+1] = " + name + "_matrix[1];\n                data[offset+2] = " + name + "_matrix[2];\n        \n                data[offset + 4] = " + name + "_matrix[3];\n                data[offset + 5] = " + name + "_matrix[4];\n                data[offset + 6] = " + name + "_matrix[5];\n        \n                data[offset + 8] = " + name + "_matrix[6];\n                data[offset + 9] = " + name + "_matrix[7];\n                data[offset + 10] = " + name + "_matrix[8];\n            ";
      }
    },
    // uploading a pixi point as a vec2 with caching layer
    {
      test: function(data, uniform) {
        return data.type === "vec2" && data.size === 1 && !data.isArray && uniform.x !== void 0;
      },
      code: function(name) {
        return '\n                cv = ud["' + name + '"].value;\n                v = uv["' + name + '"];\n\n                if(cv[0] !== v.x || cv[1] !== v.y)\n                {\n                    cv[0] = v.x;\n                    cv[1] = v.y;\n                    gl.uniform2f(ud["' + name + '"].location, v.x, v.y);\n                }';
      },
      codeUbo: function(name) {
        return "\n                v = uv." + name + ";\n\n                data[offset] = v.x;\n                data[offset+1] = v.y;\n            ";
      }
    },
    // caching layer for a vec2
    {
      test: function(data) {
        return data.type === "vec2" && data.size === 1 && !data.isArray;
      },
      code: function(name) {
        return '\n                cv = ud["' + name + '"].value;\n                v = uv["' + name + '"];\n\n                if(cv[0] !== v[0] || cv[1] !== v[1])\n                {\n                    cv[0] = v[0];\n                    cv[1] = v[1];\n                    gl.uniform2f(ud["' + name + '"].location, v[0], v[1]);\n                }\n            ';
      }
    },
    // upload a pixi rectangle as a vec4 with caching layer
    {
      test: function(data, uniform) {
        return data.type === "vec4" && data.size === 1 && !data.isArray && uniform.width !== void 0;
      },
      code: function(name) {
        return '\n                cv = ud["' + name + '"].value;\n                v = uv["' + name + '"];\n\n                if(cv[0] !== v.x || cv[1] !== v.y || cv[2] !== v.width || cv[3] !== v.height)\n                {\n                    cv[0] = v.x;\n                    cv[1] = v.y;\n                    cv[2] = v.width;\n                    cv[3] = v.height;\n                    gl.uniform4f(ud["' + name + '"].location, v.x, v.y, v.width, v.height)\n                }';
      },
      codeUbo: function(name) {
        return "\n                    v = uv." + name + ";\n\n                    data[offset] = v.x;\n                    data[offset+1] = v.y;\n                    data[offset+2] = v.width;\n                    data[offset+3] = v.height;\n                ";
      }
    },
    // a caching layer for vec4 uploading
    {
      test: function(data) {
        return data.type === "vec4" && data.size === 1 && !data.isArray;
      },
      code: function(name) {
        return '\n                cv = ud["' + name + '"].value;\n                v = uv["' + name + '"];\n\n                if(cv[0] !== v[0] || cv[1] !== v[1] || cv[2] !== v[2] || cv[3] !== v[3])\n                {\n                    cv[0] = v[0];\n                    cv[1] = v[1];\n                    cv[2] = v[2];\n                    cv[3] = v[3];\n\n                    gl.uniform4f(ud["' + name + '"].location, v[0], v[1], v[2], v[3])\n                }';
      }
    }
  ];
  var GLSL_TO_SINGLE_SETTERS_CACHED = {
    float: "\n    if (cv !== v)\n    {\n        cu.value = v;\n        gl.uniform1f(location, v);\n    }",
    vec2: "\n    if (cv[0] !== v[0] || cv[1] !== v[1])\n    {\n        cv[0] = v[0];\n        cv[1] = v[1];\n\n        gl.uniform2f(location, v[0], v[1])\n    }",
    vec3: "\n    if (cv[0] !== v[0] || cv[1] !== v[1] || cv[2] !== v[2])\n    {\n        cv[0] = v[0];\n        cv[1] = v[1];\n        cv[2] = v[2];\n\n        gl.uniform3f(location, v[0], v[1], v[2])\n    }",
    vec4: "\n    if (cv[0] !== v[0] || cv[1] !== v[1] || cv[2] !== v[2] || cv[3] !== v[3])\n    {\n        cv[0] = v[0];\n        cv[1] = v[1];\n        cv[2] = v[2];\n        cv[3] = v[3];\n\n        gl.uniform4f(location, v[0], v[1], v[2], v[3]);\n    }",
    int: "\n    if (cv !== v)\n    {\n        cu.value = v;\n\n        gl.uniform1i(location, v);\n    }",
    ivec2: "\n    if (cv[0] !== v[0] || cv[1] !== v[1])\n    {\n        cv[0] = v[0];\n        cv[1] = v[1];\n\n        gl.uniform2i(location, v[0], v[1]);\n    }",
    ivec3: "\n    if (cv[0] !== v[0] || cv[1] !== v[1] || cv[2] !== v[2])\n    {\n        cv[0] = v[0];\n        cv[1] = v[1];\n        cv[2] = v[2];\n\n        gl.uniform3i(location, v[0], v[1], v[2]);\n    }",
    ivec4: "\n    if (cv[0] !== v[0] || cv[1] !== v[1] || cv[2] !== v[2] || cv[3] !== v[3])\n    {\n        cv[0] = v[0];\n        cv[1] = v[1];\n        cv[2] = v[2];\n        cv[3] = v[3];\n\n        gl.uniform4i(location, v[0], v[1], v[2], v[3]);\n    }",
    uint: "\n    if (cv !== v)\n    {\n        cu.value = v;\n\n        gl.uniform1ui(location, v);\n    }",
    uvec2: "\n    if (cv[0] !== v[0] || cv[1] !== v[1])\n    {\n        cv[0] = v[0];\n        cv[1] = v[1];\n\n        gl.uniform2ui(location, v[0], v[1]);\n    }",
    uvec3: "\n    if (cv[0] !== v[0] || cv[1] !== v[1] || cv[2] !== v[2])\n    {\n        cv[0] = v[0];\n        cv[1] = v[1];\n        cv[2] = v[2];\n\n        gl.uniform3ui(location, v[0], v[1], v[2]);\n    }",
    uvec4: "\n    if (cv[0] !== v[0] || cv[1] !== v[1] || cv[2] !== v[2] || cv[3] !== v[3])\n    {\n        cv[0] = v[0];\n        cv[1] = v[1];\n        cv[2] = v[2];\n        cv[3] = v[3];\n\n        gl.uniform4ui(location, v[0], v[1], v[2], v[3]);\n    }",
    bool: "\n    if (cv !== v)\n    {\n        cu.value = v;\n        gl.uniform1i(location, v);\n    }",
    bvec2: "\n    if (cv[0] != v[0] || cv[1] != v[1])\n    {\n        cv[0] = v[0];\n        cv[1] = v[1];\n\n        gl.uniform2i(location, v[0], v[1]);\n    }",
    bvec3: "\n    if (cv[0] !== v[0] || cv[1] !== v[1] || cv[2] !== v[2])\n    {\n        cv[0] = v[0];\n        cv[1] = v[1];\n        cv[2] = v[2];\n\n        gl.uniform3i(location, v[0], v[1], v[2]);\n    }",
    bvec4: "\n    if (cv[0] !== v[0] || cv[1] !== v[1] || cv[2] !== v[2] || cv[3] !== v[3])\n    {\n        cv[0] = v[0];\n        cv[1] = v[1];\n        cv[2] = v[2];\n        cv[3] = v[3];\n\n        gl.uniform4i(location, v[0], v[1], v[2], v[3]);\n    }",
    mat2: "gl.uniformMatrix2fv(location, false, v)",
    mat3: "gl.uniformMatrix3fv(location, false, v)",
    mat4: "gl.uniformMatrix4fv(location, false, v)",
    sampler2D: "\n    if (cv !== v)\n    {\n        cu.value = v;\n\n        gl.uniform1i(location, v);\n    }",
    samplerCube: "\n    if (cv !== v)\n    {\n        cu.value = v;\n\n        gl.uniform1i(location, v);\n    }",
    sampler2DArray: "\n    if (cv !== v)\n    {\n        cu.value = v;\n\n        gl.uniform1i(location, v);\n    }"
  };
  var GLSL_TO_ARRAY_SETTERS = {
    float: "gl.uniform1fv(location, v)",
    vec2: "gl.uniform2fv(location, v)",
    vec3: "gl.uniform3fv(location, v)",
    vec4: "gl.uniform4fv(location, v)",
    mat4: "gl.uniformMatrix4fv(location, false, v)",
    mat3: "gl.uniformMatrix3fv(location, false, v)",
    mat2: "gl.uniformMatrix2fv(location, false, v)",
    int: "gl.uniform1iv(location, v)",
    ivec2: "gl.uniform2iv(location, v)",
    ivec3: "gl.uniform3iv(location, v)",
    ivec4: "gl.uniform4iv(location, v)",
    uint: "gl.uniform1uiv(location, v)",
    uvec2: "gl.uniform2uiv(location, v)",
    uvec3: "gl.uniform3uiv(location, v)",
    uvec4: "gl.uniform4uiv(location, v)",
    bool: "gl.uniform1iv(location, v)",
    bvec2: "gl.uniform2iv(location, v)",
    bvec3: "gl.uniform3iv(location, v)",
    bvec4: "gl.uniform4iv(location, v)",
    sampler2D: "gl.uniform1iv(location, v)",
    samplerCube: "gl.uniform1iv(location, v)",
    sampler2DArray: "gl.uniform1iv(location, v)"
  };
  function generateUniformsSync(group, uniformData) {
    var _a;
    var funcFragments = ["\n        var v = null;\n        var cv = null;\n        var cu = null;\n        var t = 0;\n        var gl = renderer.gl;\n    "];
    for (var i in group.uniforms) {
      var data = uniformData[i];
      if (!data) {
        if ((_a = group.uniforms[i]) === null || _a === void 0 ? void 0 : _a.group) {
          if (group.uniforms[i].ubo) {
            funcFragments.push("\n                        renderer.shader.syncUniformBufferGroup(uv." + i + ", '" + i + "');\n                    ");
          } else {
            funcFragments.push("\n                        renderer.shader.syncUniformGroup(uv." + i + ", syncData);\n                    ");
          }
        }
        continue;
      }
      var uniform = group.uniforms[i];
      var parsed = false;
      for (var j = 0; j < uniformParsers.length; j++) {
        if (uniformParsers[j].test(data, uniform)) {
          funcFragments.push(uniformParsers[j].code(i, uniform));
          parsed = true;
          break;
        }
      }
      if (!parsed) {
        var templateType = data.size === 1 && !data.isArray ? GLSL_TO_SINGLE_SETTERS_CACHED : GLSL_TO_ARRAY_SETTERS;
        var template = templateType[data.type].replace("location", 'ud["' + i + '"].location');
        funcFragments.push('\n            cu = ud["' + i + '"];\n            cv = cu.value;\n            v = uv["' + i + '"];\n            ' + template + ";");
      }
    }
    return new Function("ud", "uv", "renderer", "syncData", funcFragments.join("\n"));
  }
  var fragTemplate = [
    "precision mediump float;",
    "void main(void){",
    "float test = 0.1;",
    "%forloop%",
    "gl_FragColor = vec4(0.0);",
    "}"
  ].join("\n");
  function generateIfTestSrc(maxIfs) {
    var src = "";
    for (var i = 0; i < maxIfs; ++i) {
      if (i > 0) {
        src += "\nelse ";
      }
      if (i < maxIfs - 1) {
        src += "if(test == " + i + ".0){}";
      }
    }
    return src;
  }
  function checkMaxIfStatementsInShader(maxIfs, gl) {
    if (maxIfs === 0) {
      throw new Error("Invalid value of `0` passed to `checkMaxIfStatementsInShader`");
    }
    var shader = gl.createShader(gl.FRAGMENT_SHADER);
    while (true) {
      var fragmentSrc = fragTemplate.replace(/%forloop%/gi, generateIfTestSrc(maxIfs));
      gl.shaderSource(shader, fragmentSrc);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        maxIfs = maxIfs / 2 | 0;
      } else {
        break;
      }
    }
    return maxIfs;
  }
  var unsafeEval;
  function unsafeEvalSupported() {
    if (typeof unsafeEval === "boolean") {
      return unsafeEval;
    }
    try {
      var func = new Function("param1", "param2", "param3", "return param1[param2] === param3;");
      unsafeEval = func({ a: "b" }, "a", "b") === true;
    } catch (e) {
      unsafeEval = false;
    }
    return unsafeEval;
  }
  var defaultFragment$2 = "varying vec2 vTextureCoord;\n\nuniform sampler2D uSampler;\n\nvoid main(void){\n   gl_FragColor *= texture2D(uSampler, vTextureCoord);\n}";
  var defaultVertex$3 = "attribute vec2 aVertexPosition;\nattribute vec2 aTextureCoord;\n\nuniform mat3 projectionMatrix;\n\nvarying vec2 vTextureCoord;\n\nvoid main(void){\n   gl_Position = vec4((projectionMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);\n   vTextureCoord = aTextureCoord;\n}\n";
  var UID$1 = 0;
  var nameCache = {};
  var Program = (
    /** @class */
    (function() {
      function Program2(vertexSrc, fragmentSrc, name) {
        if (name === void 0) {
          name = "pixi-shader";
        }
        this.id = UID$1++;
        this.vertexSrc = vertexSrc || Program2.defaultVertexSrc;
        this.fragmentSrc = fragmentSrc || Program2.defaultFragmentSrc;
        this.vertexSrc = this.vertexSrc.trim();
        this.fragmentSrc = this.fragmentSrc.trim();
        if (this.vertexSrc.substring(0, 8) !== "#version") {
          name = name.replace(/\s+/g, "-");
          if (nameCache[name]) {
            nameCache[name]++;
            name += "-" + nameCache[name];
          } else {
            nameCache[name] = 1;
          }
          this.vertexSrc = "#define SHADER_NAME " + name + "\n" + this.vertexSrc;
          this.fragmentSrc = "#define SHADER_NAME " + name + "\n" + this.fragmentSrc;
          this.vertexSrc = setPrecision(this.vertexSrc, settings.PRECISION_VERTEX, PRECISION.HIGH);
          this.fragmentSrc = setPrecision(this.fragmentSrc, settings.PRECISION_FRAGMENT, getMaxFragmentPrecision());
        }
        this.glPrograms = {};
        this.syncUniforms = null;
      }
      Object.defineProperty(Program2, "defaultVertexSrc", {
        /**
         * The default vertex shader source.
         * @constant
         */
        get: function() {
          return defaultVertex$3;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(Program2, "defaultFragmentSrc", {
        /**
         * The default fragment shader source.
         * @constant
         */
        get: function() {
          return defaultFragment$2;
        },
        enumerable: false,
        configurable: true
      });
      Program2.from = function(vertexSrc, fragmentSrc, name) {
        var key = vertexSrc + fragmentSrc;
        var program = ProgramCache[key];
        if (!program) {
          ProgramCache[key] = program = new Program2(vertexSrc, fragmentSrc, name);
        }
        return program;
      };
      return Program2;
    })()
  );
  var Shader = (
    /** @class */
    (function() {
      function Shader2(program, uniforms) {
        this.uniformBindCount = 0;
        this.program = program;
        if (uniforms) {
          if (uniforms instanceof UniformGroup) {
            this.uniformGroup = uniforms;
          } else {
            this.uniformGroup = new UniformGroup(uniforms);
          }
        } else {
          this.uniformGroup = new UniformGroup({});
        }
        this.disposeRunner = new Runner("disposeShader");
      }
      Shader2.prototype.checkUniformExists = function(name, group) {
        if (group.uniforms[name]) {
          return true;
        }
        for (var i in group.uniforms) {
          var uniform = group.uniforms[i];
          if (uniform.group) {
            if (this.checkUniformExists(name, uniform)) {
              return true;
            }
          }
        }
        return false;
      };
      Shader2.prototype.destroy = function() {
        this.uniformGroup = null;
        this.disposeRunner.emit(this);
        this.disposeRunner.destroy();
      };
      Object.defineProperty(Shader2.prototype, "uniforms", {
        /**
         * Shader uniform values, shortcut for `uniformGroup.uniforms`.
         * @readonly
         */
        get: function() {
          return this.uniformGroup.uniforms;
        },
        enumerable: false,
        configurable: true
      });
      Shader2.from = function(vertexSrc, fragmentSrc, uniforms) {
        var program = Program.from(vertexSrc, fragmentSrc);
        return new Shader2(program, uniforms);
      };
      return Shader2;
    })()
  );
  var BLEND$1 = 0;
  var OFFSET$1 = 1;
  var CULLING$1 = 2;
  var DEPTH_TEST$1 = 3;
  var WINDING$1 = 4;
  var DEPTH_MASK$1 = 5;
  var State = (
    /** @class */
    (function() {
      function State2() {
        this.data = 0;
        this.blendMode = BLEND_MODES.NORMAL;
        this.polygonOffset = 0;
        this.blend = true;
        this.depthMask = true;
      }
      Object.defineProperty(State2.prototype, "blend", {
        /**
         * Activates blending of the computed fragment color values.
         * @default true
         */
        get: function() {
          return !!(this.data & 1 << BLEND$1);
        },
        set: function(value) {
          if (!!(this.data & 1 << BLEND$1) !== value) {
            this.data ^= 1 << BLEND$1;
          }
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(State2.prototype, "offsets", {
        /**
         * Activates adding an offset to depth values of polygon's fragments
         * @default false
         */
        get: function() {
          return !!(this.data & 1 << OFFSET$1);
        },
        set: function(value) {
          if (!!(this.data & 1 << OFFSET$1) !== value) {
            this.data ^= 1 << OFFSET$1;
          }
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(State2.prototype, "culling", {
        /**
         * Activates culling of polygons.
         * @default false
         */
        get: function() {
          return !!(this.data & 1 << CULLING$1);
        },
        set: function(value) {
          if (!!(this.data & 1 << CULLING$1) !== value) {
            this.data ^= 1 << CULLING$1;
          }
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(State2.prototype, "depthTest", {
        /**
         * Activates depth comparisons and updates to the depth buffer.
         * @default false
         */
        get: function() {
          return !!(this.data & 1 << DEPTH_TEST$1);
        },
        set: function(value) {
          if (!!(this.data & 1 << DEPTH_TEST$1) !== value) {
            this.data ^= 1 << DEPTH_TEST$1;
          }
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(State2.prototype, "depthMask", {
        /**
         * Enables or disables writing to the depth buffer.
         * @default true
         */
        get: function() {
          return !!(this.data & 1 << DEPTH_MASK$1);
        },
        set: function(value) {
          if (!!(this.data & 1 << DEPTH_MASK$1) !== value) {
            this.data ^= 1 << DEPTH_MASK$1;
          }
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(State2.prototype, "clockwiseFrontFace", {
        /**
         * Specifies whether or not front or back-facing polygons can be culled.
         * @default false
         */
        get: function() {
          return !!(this.data & 1 << WINDING$1);
        },
        set: function(value) {
          if (!!(this.data & 1 << WINDING$1) !== value) {
            this.data ^= 1 << WINDING$1;
          }
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(State2.prototype, "blendMode", {
        /**
         * The blend mode to be applied when this state is set. Apply a value of `PIXI.BLEND_MODES.NORMAL` to reset the blend mode.
         * Setting this mode to anything other than NO_BLEND will automatically switch blending on.
         * @default PIXI.BLEND_MODES.NORMAL
         */
        get: function() {
          return this._blendMode;
        },
        set: function(value) {
          this.blend = value !== BLEND_MODES.NONE;
          this._blendMode = value;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(State2.prototype, "polygonOffset", {
        /**
         * The polygon offset. Setting this property to anything other than 0 will automatically enable polygon offset fill.
         * @default 0
         */
        get: function() {
          return this._polygonOffset;
        },
        set: function(value) {
          this.offsets = !!value;
          this._polygonOffset = value;
        },
        enumerable: false,
        configurable: true
      });
      State2.prototype.toString = function() {
        return "[@pixi/core:State " + ("blendMode=" + this.blendMode + " ") + ("clockwiseFrontFace=" + this.clockwiseFrontFace + " ") + ("culling=" + this.culling + " ") + ("depthMask=" + this.depthMask + " ") + ("polygonOffset=" + this.polygonOffset) + "]";
      };
      State2.for2d = function() {
        var state = new State2();
        state.depthTest = false;
        state.blend = true;
        return state;
      };
      return State2;
    })()
  );
  var defaultFragment$1 = "varying vec2 vTextureCoord;\n\nuniform sampler2D uSampler;\n\nvoid main(void){\n   gl_FragColor = texture2D(uSampler, vTextureCoord);\n}\n";
  var defaultVertex$2 = "attribute vec2 aVertexPosition;\n\nuniform mat3 projectionMatrix;\n\nvarying vec2 vTextureCoord;\n\nuniform vec4 inputSize;\nuniform vec4 outputFrame;\n\nvec4 filterVertexPosition( void )\n{\n    vec2 position = aVertexPosition * max(outputFrame.zw, vec2(0.)) + outputFrame.xy;\n\n    return vec4((projectionMatrix * vec3(position, 1.0)).xy, 0.0, 1.0);\n}\n\nvec2 filterTextureCoord( void )\n{\n    return aVertexPosition * (outputFrame.zw * inputSize.zw);\n}\n\nvoid main(void)\n{\n    gl_Position = filterVertexPosition();\n    vTextureCoord = filterTextureCoord();\n}\n";
  var Filter = (
    /** @class */
    (function(_super) {
      __extends(Filter2, _super);
      function Filter2(vertexSrc, fragmentSrc, uniforms) {
        var _this = this;
        var program = Program.from(vertexSrc || Filter2.defaultVertexSrc, fragmentSrc || Filter2.defaultFragmentSrc);
        _this = _super.call(this, program, uniforms) || this;
        _this.padding = 0;
        _this.resolution = settings.FILTER_RESOLUTION;
        _this.multisample = settings.FILTER_MULTISAMPLE;
        _this.enabled = true;
        _this.autoFit = true;
        _this.state = new State();
        return _this;
      }
      Filter2.prototype.apply = function(filterManager, input, output, clearMode, _currentState) {
        filterManager.applyFilter(this, input, output, clearMode);
      };
      Object.defineProperty(Filter2.prototype, "blendMode", {
        /**
         * Sets the blend mode of the filter.
         * @default PIXI.BLEND_MODES.NORMAL
         */
        get: function() {
          return this.state.blendMode;
        },
        set: function(value) {
          this.state.blendMode = value;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(Filter2.prototype, "resolution", {
        /**
         * The resolution of the filter. Setting this to be lower will lower the quality but
         * increase the performance of the filter.
         */
        get: function() {
          return this._resolution;
        },
        set: function(value) {
          this._resolution = value;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(Filter2, "defaultVertexSrc", {
        /**
         * The default vertex shader source
         * @constant
         */
        get: function() {
          return defaultVertex$2;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(Filter2, "defaultFragmentSrc", {
        /**
         * The default fragment shader source
         * @constant
         */
        get: function() {
          return defaultFragment$1;
        },
        enumerable: false,
        configurable: true
      });
      return Filter2;
    })(Shader)
  );
  var vertex = "attribute vec2 aVertexPosition;\nattribute vec2 aTextureCoord;\n\nuniform mat3 projectionMatrix;\nuniform mat3 otherMatrix;\n\nvarying vec2 vMaskCoord;\nvarying vec2 vTextureCoord;\n\nvoid main(void)\n{\n    gl_Position = vec4((projectionMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);\n\n    vTextureCoord = aTextureCoord;\n    vMaskCoord = ( otherMatrix * vec3( aTextureCoord, 1.0)  ).xy;\n}\n";
  var fragment = "varying vec2 vMaskCoord;\nvarying vec2 vTextureCoord;\n\nuniform sampler2D uSampler;\nuniform sampler2D mask;\nuniform float alpha;\nuniform float npmAlpha;\nuniform vec4 maskClamp;\n\nvoid main(void)\n{\n    float clip = step(3.5,\n        step(maskClamp.x, vMaskCoord.x) +\n        step(maskClamp.y, vMaskCoord.y) +\n        step(vMaskCoord.x, maskClamp.z) +\n        step(vMaskCoord.y, maskClamp.w));\n\n    vec4 original = texture2D(uSampler, vTextureCoord);\n    vec4 masky = texture2D(mask, vMaskCoord);\n    float alphaMul = 1.0 - npmAlpha * (1.0 - masky.a);\n\n    original *= (alphaMul * masky.r * alpha * clip);\n\n    gl_FragColor = original;\n}\n";
  var tempMat = new Matrix();
  var TextureMatrix = (
    /** @class */
    (function() {
      function TextureMatrix2(texture, clampMargin) {
        this._texture = texture;
        this.mapCoord = new Matrix();
        this.uClampFrame = new Float32Array(4);
        this.uClampOffset = new Float32Array(2);
        this._textureID = -1;
        this._updateID = 0;
        this.clampOffset = 0;
        this.clampMargin = typeof clampMargin === "undefined" ? 0.5 : clampMargin;
        this.isSimple = false;
      }
      Object.defineProperty(TextureMatrix2.prototype, "texture", {
        /** Texture property. */
        get: function() {
          return this._texture;
        },
        set: function(value) {
          this._texture = value;
          this._textureID = -1;
        },
        enumerable: false,
        configurable: true
      });
      TextureMatrix2.prototype.multiplyUvs = function(uvs, out) {
        if (out === void 0) {
          out = uvs;
        }
        var mat = this.mapCoord;
        for (var i = 0; i < uvs.length; i += 2) {
          var x = uvs[i];
          var y = uvs[i + 1];
          out[i] = x * mat.a + y * mat.c + mat.tx;
          out[i + 1] = x * mat.b + y * mat.d + mat.ty;
        }
        return out;
      };
      TextureMatrix2.prototype.update = function(forceUpdate) {
        var tex = this._texture;
        if (!tex || !tex.valid) {
          return false;
        }
        if (!forceUpdate && this._textureID === tex._updateID) {
          return false;
        }
        this._textureID = tex._updateID;
        this._updateID++;
        var uvs = tex._uvs;
        this.mapCoord.set(uvs.x1 - uvs.x0, uvs.y1 - uvs.y0, uvs.x3 - uvs.x0, uvs.y3 - uvs.y0, uvs.x0, uvs.y0);
        var orig = tex.orig;
        var trim = tex.trim;
        if (trim) {
          tempMat.set(orig.width / trim.width, 0, 0, orig.height / trim.height, -trim.x / trim.width, -trim.y / trim.height);
          this.mapCoord.append(tempMat);
        }
        var texBase = tex.baseTexture;
        var frame = this.uClampFrame;
        var margin = this.clampMargin / texBase.resolution;
        var offset = this.clampOffset;
        frame[0] = (tex._frame.x + margin + offset) / texBase.width;
        frame[1] = (tex._frame.y + margin + offset) / texBase.height;
        frame[2] = (tex._frame.x + tex._frame.width - margin + offset) / texBase.width;
        frame[3] = (tex._frame.y + tex._frame.height - margin + offset) / texBase.height;
        this.uClampOffset[0] = offset / texBase.realWidth;
        this.uClampOffset[1] = offset / texBase.realHeight;
        this.isSimple = tex._frame.width === texBase.width && tex._frame.height === texBase.height && tex.rotate === 0;
        return true;
      };
      return TextureMatrix2;
    })()
  );
  var SpriteMaskFilter = (
    /** @class */
    (function(_super) {
      __extends(SpriteMaskFilter2, _super);
      function SpriteMaskFilter2(vertexSrc, fragmentSrc, uniforms) {
        var _this = this;
        var sprite = null;
        if (typeof vertexSrc !== "string" && fragmentSrc === void 0 && uniforms === void 0) {
          sprite = vertexSrc;
          vertexSrc = void 0;
          fragmentSrc = void 0;
          uniforms = void 0;
        }
        _this = _super.call(this, vertexSrc || vertex, fragmentSrc || fragment, uniforms) || this;
        _this.maskSprite = sprite;
        _this.maskMatrix = new Matrix();
        return _this;
      }
      Object.defineProperty(SpriteMaskFilter2.prototype, "maskSprite", {
        /**
         * Sprite mask
         * @type {PIXI.DisplayObject}
         */
        get: function() {
          return this._maskSprite;
        },
        set: function(value) {
          this._maskSprite = value;
          if (this._maskSprite) {
            this._maskSprite.renderable = false;
          }
        },
        enumerable: false,
        configurable: true
      });
      SpriteMaskFilter2.prototype.apply = function(filterManager, input, output, clearMode) {
        var maskSprite = this._maskSprite;
        var tex = maskSprite._texture;
        if (!tex.valid) {
          return;
        }
        if (!tex.uvMatrix) {
          tex.uvMatrix = new TextureMatrix(tex, 0);
        }
        tex.uvMatrix.update();
        this.uniforms.npmAlpha = tex.baseTexture.alphaMode ? 0 : 1;
        this.uniforms.mask = tex;
        this.uniforms.otherMatrix = filterManager.calculateSpriteMatrix(this.maskMatrix, maskSprite).prepend(tex.uvMatrix.mapCoord);
        this.uniforms.alpha = maskSprite.worldAlpha;
        this.uniforms.maskClamp = tex.uvMatrix.uClampFrame;
        filterManager.applyFilter(this, input, output, clearMode);
      };
      return SpriteMaskFilter2;
    })(Filter)
  );
  var MaskSystem = (
    /** @class */
    (function() {
      function MaskSystem2(renderer) {
        this.renderer = renderer;
        this.enableScissor = true;
        this.alphaMaskPool = [];
        this.maskDataPool = [];
        this.maskStack = [];
        this.alphaMaskIndex = 0;
      }
      MaskSystem2.prototype.setMaskStack = function(maskStack) {
        this.maskStack = maskStack;
        this.renderer.scissor.setMaskStack(maskStack);
        this.renderer.stencil.setMaskStack(maskStack);
      };
      MaskSystem2.prototype.push = function(target, maskDataOrTarget) {
        var maskData = maskDataOrTarget;
        if (!maskData.isMaskData) {
          var d = this.maskDataPool.pop() || new MaskData();
          d.pooled = true;
          d.maskObject = maskDataOrTarget;
          maskData = d;
        }
        var maskAbove = this.maskStack.length !== 0 ? this.maskStack[this.maskStack.length - 1] : null;
        maskData.copyCountersOrReset(maskAbove);
        maskData._colorMask = maskAbove ? maskAbove._colorMask : 15;
        if (maskData.autoDetect) {
          this.detect(maskData);
        }
        maskData._target = target;
        if (maskData.type !== MASK_TYPES.SPRITE) {
          this.maskStack.push(maskData);
        }
        if (maskData.enabled) {
          switch (maskData.type) {
            case MASK_TYPES.SCISSOR:
              this.renderer.scissor.push(maskData);
              break;
            case MASK_TYPES.STENCIL:
              this.renderer.stencil.push(maskData);
              break;
            case MASK_TYPES.SPRITE:
              maskData.copyCountersOrReset(null);
              this.pushSpriteMask(maskData);
              break;
            case MASK_TYPES.COLOR:
              this.pushColorMask(maskData);
              break;
          }
        }
        if (maskData.type === MASK_TYPES.SPRITE) {
          this.maskStack.push(maskData);
        }
      };
      MaskSystem2.prototype.pop = function(target) {
        var maskData = this.maskStack.pop();
        if (!maskData || maskData._target !== target) {
          return;
        }
        if (maskData.enabled) {
          switch (maskData.type) {
            case MASK_TYPES.SCISSOR:
              this.renderer.scissor.pop(maskData);
              break;
            case MASK_TYPES.STENCIL:
              this.renderer.stencil.pop(maskData.maskObject);
              break;
            case MASK_TYPES.SPRITE:
              this.popSpriteMask(maskData);
              break;
            case MASK_TYPES.COLOR:
              this.popColorMask(maskData);
              break;
          }
        }
        maskData.reset();
        if (maskData.pooled) {
          this.maskDataPool.push(maskData);
        }
        if (this.maskStack.length !== 0) {
          var maskCurrent = this.maskStack[this.maskStack.length - 1];
          if (maskCurrent.type === MASK_TYPES.SPRITE && maskCurrent._filters) {
            maskCurrent._filters[0].maskSprite = maskCurrent.maskObject;
          }
        }
      };
      MaskSystem2.prototype.detect = function(maskData) {
        var maskObject = maskData.maskObject;
        if (!maskObject) {
          maskData.type = MASK_TYPES.COLOR;
        } else if (maskObject.isSprite) {
          maskData.type = MASK_TYPES.SPRITE;
        } else if (this.enableScissor && this.renderer.scissor.testScissor(maskData)) {
          maskData.type = MASK_TYPES.SCISSOR;
        } else {
          maskData.type = MASK_TYPES.STENCIL;
        }
      };
      MaskSystem2.prototype.pushSpriteMask = function(maskData) {
        var _a, _b;
        var maskObject = maskData.maskObject;
        var target = maskData._target;
        var alphaMaskFilter = maskData._filters;
        if (!alphaMaskFilter) {
          alphaMaskFilter = this.alphaMaskPool[this.alphaMaskIndex];
          if (!alphaMaskFilter) {
            alphaMaskFilter = this.alphaMaskPool[this.alphaMaskIndex] = [new SpriteMaskFilter()];
          }
        }
        var renderer = this.renderer;
        var renderTextureSystem = renderer.renderTexture;
        var resolution;
        var multisample;
        if (renderTextureSystem.current) {
          var renderTexture = renderTextureSystem.current;
          resolution = maskData.resolution || renderTexture.resolution;
          multisample = (_a = maskData.multisample) !== null && _a !== void 0 ? _a : renderTexture.multisample;
        } else {
          resolution = maskData.resolution || renderer.resolution;
          multisample = (_b = maskData.multisample) !== null && _b !== void 0 ? _b : renderer.multisample;
        }
        alphaMaskFilter[0].resolution = resolution;
        alphaMaskFilter[0].multisample = multisample;
        alphaMaskFilter[0].maskSprite = maskObject;
        var stashFilterArea = target.filterArea;
        target.filterArea = maskObject.getBounds(true);
        renderer.filter.push(target, alphaMaskFilter);
        target.filterArea = stashFilterArea;
        if (!maskData._filters) {
          this.alphaMaskIndex++;
        }
      };
      MaskSystem2.prototype.popSpriteMask = function(maskData) {
        this.renderer.filter.pop();
        if (maskData._filters) {
          maskData._filters[0].maskSprite = null;
        } else {
          this.alphaMaskIndex--;
          this.alphaMaskPool[this.alphaMaskIndex][0].maskSprite = null;
        }
      };
      MaskSystem2.prototype.pushColorMask = function(maskData) {
        var currColorMask = maskData._colorMask;
        var nextColorMask = maskData._colorMask = currColorMask & maskData.colorMask;
        if (nextColorMask !== currColorMask) {
          this.renderer.gl.colorMask((nextColorMask & 1) !== 0, (nextColorMask & 2) !== 0, (nextColorMask & 4) !== 0, (nextColorMask & 8) !== 0);
        }
      };
      MaskSystem2.prototype.popColorMask = function(maskData) {
        var currColorMask = maskData._colorMask;
        var nextColorMask = this.maskStack.length > 0 ? this.maskStack[this.maskStack.length - 1]._colorMask : 15;
        if (nextColorMask !== currColorMask) {
          this.renderer.gl.colorMask((nextColorMask & 1) !== 0, (nextColorMask & 2) !== 0, (nextColorMask & 4) !== 0, (nextColorMask & 8) !== 0);
        }
      };
      MaskSystem2.prototype.destroy = function() {
        this.renderer = null;
      };
      return MaskSystem2;
    })()
  );
  var AbstractMaskSystem = (
    /** @class */
    (function() {
      function AbstractMaskSystem2(renderer) {
        this.renderer = renderer;
        this.maskStack = [];
        this.glConst = 0;
      }
      AbstractMaskSystem2.prototype.getStackLength = function() {
        return this.maskStack.length;
      };
      AbstractMaskSystem2.prototype.setMaskStack = function(maskStack) {
        var gl = this.renderer.gl;
        var curStackLen = this.getStackLength();
        this.maskStack = maskStack;
        var newStackLen = this.getStackLength();
        if (newStackLen !== curStackLen) {
          if (newStackLen === 0) {
            gl.disable(this.glConst);
          } else {
            gl.enable(this.glConst);
            this._useCurrent();
          }
        }
      };
      AbstractMaskSystem2.prototype._useCurrent = function() {
      };
      AbstractMaskSystem2.prototype.destroy = function() {
        this.renderer = null;
        this.maskStack = null;
      };
      return AbstractMaskSystem2;
    })()
  );
  var tempMatrix$1 = new Matrix();
  var rectPool = [];
  var ScissorSystem = (
    /** @class */
    (function(_super) {
      __extends(ScissorSystem2, _super);
      function ScissorSystem2(renderer) {
        var _this = _super.call(this, renderer) || this;
        _this.glConst = settings.ADAPTER.getWebGLRenderingContext().SCISSOR_TEST;
        return _this;
      }
      ScissorSystem2.prototype.getStackLength = function() {
        var maskData = this.maskStack[this.maskStack.length - 1];
        if (maskData) {
          return maskData._scissorCounter;
        }
        return 0;
      };
      ScissorSystem2.prototype.calcScissorRect = function(maskData) {
        var _a;
        if (maskData._scissorRectLocal) {
          return;
        }
        var prevData = maskData._scissorRect;
        var maskObject = maskData.maskObject;
        var renderer = this.renderer;
        var renderTextureSystem = renderer.renderTexture;
        var rect = maskObject.getBounds(true, (_a = rectPool.pop()) !== null && _a !== void 0 ? _a : new Rectangle());
        this.roundFrameToPixels(rect, renderTextureSystem.current ? renderTextureSystem.current.resolution : renderer.resolution, renderTextureSystem.sourceFrame, renderTextureSystem.destinationFrame, renderer.projection.transform);
        if (prevData) {
          rect.fit(prevData);
        }
        maskData._scissorRectLocal = rect;
      };
      ScissorSystem2.isMatrixRotated = function(matrix) {
        if (!matrix) {
          return false;
        }
        var a = matrix.a, b = matrix.b, c = matrix.c, d = matrix.d;
        return (Math.abs(b) > 1e-4 || Math.abs(c) > 1e-4) && (Math.abs(a) > 1e-4 || Math.abs(d) > 1e-4);
      };
      ScissorSystem2.prototype.testScissor = function(maskData) {
        var maskObject = maskData.maskObject;
        if (!maskObject.isFastRect || !maskObject.isFastRect()) {
          return false;
        }
        if (ScissorSystem2.isMatrixRotated(maskObject.worldTransform)) {
          return false;
        }
        if (ScissorSystem2.isMatrixRotated(this.renderer.projection.transform)) {
          return false;
        }
        this.calcScissorRect(maskData);
        var rect = maskData._scissorRectLocal;
        return rect.width > 0 && rect.height > 0;
      };
      ScissorSystem2.prototype.roundFrameToPixels = function(frame, resolution, bindingSourceFrame, bindingDestinationFrame, transform) {
        if (ScissorSystem2.isMatrixRotated(transform)) {
          return;
        }
        transform = transform ? tempMatrix$1.copyFrom(transform) : tempMatrix$1.identity();
        transform.translate(-bindingSourceFrame.x, -bindingSourceFrame.y).scale(bindingDestinationFrame.width / bindingSourceFrame.width, bindingDestinationFrame.height / bindingSourceFrame.height).translate(bindingDestinationFrame.x, bindingDestinationFrame.y);
        this.renderer.filter.transformAABB(transform, frame);
        frame.fit(bindingDestinationFrame);
        frame.x = Math.round(frame.x * resolution);
        frame.y = Math.round(frame.y * resolution);
        frame.width = Math.round(frame.width * resolution);
        frame.height = Math.round(frame.height * resolution);
      };
      ScissorSystem2.prototype.push = function(maskData) {
        if (!maskData._scissorRectLocal) {
          this.calcScissorRect(maskData);
        }
        var gl = this.renderer.gl;
        if (!maskData._scissorRect) {
          gl.enable(gl.SCISSOR_TEST);
        }
        maskData._scissorCounter++;
        maskData._scissorRect = maskData._scissorRectLocal;
        this._useCurrent();
      };
      ScissorSystem2.prototype.pop = function(maskData) {
        var gl = this.renderer.gl;
        if (maskData) {
          rectPool.push(maskData._scissorRectLocal);
        }
        if (this.getStackLength() > 0) {
          this._useCurrent();
        } else {
          gl.disable(gl.SCISSOR_TEST);
        }
      };
      ScissorSystem2.prototype._useCurrent = function() {
        var rect = this.maskStack[this.maskStack.length - 1]._scissorRect;
        var y;
        if (this.renderer.renderTexture.current) {
          y = rect.y;
        } else {
          y = this.renderer.height - rect.height - rect.y;
        }
        this.renderer.gl.scissor(rect.x, y, rect.width, rect.height);
      };
      return ScissorSystem2;
    })(AbstractMaskSystem)
  );
  var StencilSystem = (
    /** @class */
    (function(_super) {
      __extends(StencilSystem2, _super);
      function StencilSystem2(renderer) {
        var _this = _super.call(this, renderer) || this;
        _this.glConst = settings.ADAPTER.getWebGLRenderingContext().STENCIL_TEST;
        return _this;
      }
      StencilSystem2.prototype.getStackLength = function() {
        var maskData = this.maskStack[this.maskStack.length - 1];
        if (maskData) {
          return maskData._stencilCounter;
        }
        return 0;
      };
      StencilSystem2.prototype.push = function(maskData) {
        var maskObject = maskData.maskObject;
        var gl = this.renderer.gl;
        var prevMaskCount = maskData._stencilCounter;
        if (prevMaskCount === 0) {
          this.renderer.framebuffer.forceStencil();
          gl.clearStencil(0);
          gl.clear(gl.STENCIL_BUFFER_BIT);
          gl.enable(gl.STENCIL_TEST);
        }
        maskData._stencilCounter++;
        var colorMask = maskData._colorMask;
        if (colorMask !== 0) {
          maskData._colorMask = 0;
          gl.colorMask(false, false, false, false);
        }
        gl.stencilFunc(gl.EQUAL, prevMaskCount, 4294967295);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
        maskObject.renderable = true;
        maskObject.render(this.renderer);
        this.renderer.batch.flush();
        maskObject.renderable = false;
        if (colorMask !== 0) {
          maskData._colorMask = colorMask;
          gl.colorMask((colorMask & 1) !== 0, (colorMask & 2) !== 0, (colorMask & 4) !== 0, (colorMask & 8) !== 0);
        }
        this._useCurrent();
      };
      StencilSystem2.prototype.pop = function(maskObject) {
        var gl = this.renderer.gl;
        if (this.getStackLength() === 0) {
          gl.disable(gl.STENCIL_TEST);
        } else {
          var maskData = this.maskStack.length !== 0 ? this.maskStack[this.maskStack.length - 1] : null;
          var colorMask = maskData ? maskData._colorMask : 15;
          if (colorMask !== 0) {
            maskData._colorMask = 0;
            gl.colorMask(false, false, false, false);
          }
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.DECR);
          maskObject.renderable = true;
          maskObject.render(this.renderer);
          this.renderer.batch.flush();
          maskObject.renderable = false;
          if (colorMask !== 0) {
            maskData._colorMask = colorMask;
            gl.colorMask((colorMask & 1) !== 0, (colorMask & 2) !== 0, (colorMask & 4) !== 0, (colorMask & 8) !== 0);
          }
          this._useCurrent();
        }
      };
      StencilSystem2.prototype._useCurrent = function() {
        var gl = this.renderer.gl;
        gl.stencilFunc(gl.EQUAL, this.getStackLength(), 4294967295);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      };
      return StencilSystem2;
    })(AbstractMaskSystem)
  );
  var ProjectionSystem = (
    /** @class */
    (function() {
      function ProjectionSystem2(renderer) {
        this.renderer = renderer;
        this.destinationFrame = null;
        this.sourceFrame = null;
        this.defaultFrame = null;
        this.projectionMatrix = new Matrix();
        this.transform = null;
      }
      ProjectionSystem2.prototype.update = function(destinationFrame, sourceFrame, resolution, root) {
        this.destinationFrame = destinationFrame || this.destinationFrame || this.defaultFrame;
        this.sourceFrame = sourceFrame || this.sourceFrame || destinationFrame;
        this.calculateProjection(this.destinationFrame, this.sourceFrame, resolution, root);
        if (this.transform) {
          this.projectionMatrix.append(this.transform);
        }
        var renderer = this.renderer;
        renderer.globalUniforms.uniforms.projectionMatrix = this.projectionMatrix;
        renderer.globalUniforms.update();
        if (renderer.shader.shader) {
          renderer.shader.syncUniformGroup(renderer.shader.shader.uniforms.globals);
        }
      };
      ProjectionSystem2.prototype.calculateProjection = function(_destinationFrame, sourceFrame, _resolution, root) {
        var pm = this.projectionMatrix;
        var sign = !root ? 1 : -1;
        pm.identity();
        pm.a = 1 / sourceFrame.width * 2;
        pm.d = sign * (1 / sourceFrame.height * 2);
        pm.tx = -1 - sourceFrame.x * pm.a;
        pm.ty = -sign - sourceFrame.y * pm.d;
      };
      ProjectionSystem2.prototype.setTransform = function(_matrix) {
      };
      ProjectionSystem2.prototype.destroy = function() {
        this.renderer = null;
      };
      return ProjectionSystem2;
    })()
  );
  var tempRect = new Rectangle();
  var tempRect2 = new Rectangle();
  var RenderTextureSystem = (
    /** @class */
    (function() {
      function RenderTextureSystem2(renderer) {
        this.renderer = renderer;
        this.clearColor = renderer._backgroundColorRgba;
        this.defaultMaskStack = [];
        this.current = null;
        this.sourceFrame = new Rectangle();
        this.destinationFrame = new Rectangle();
        this.viewportFrame = new Rectangle();
      }
      RenderTextureSystem2.prototype.bind = function(renderTexture, sourceFrame, destinationFrame) {
        if (renderTexture === void 0) {
          renderTexture = null;
        }
        var renderer = this.renderer;
        this.current = renderTexture;
        var baseTexture;
        var framebuffer;
        var resolution;
        if (renderTexture) {
          baseTexture = renderTexture.baseTexture;
          resolution = baseTexture.resolution;
          if (!sourceFrame) {
            tempRect.width = renderTexture.frame.width;
            tempRect.height = renderTexture.frame.height;
            sourceFrame = tempRect;
          }
          if (!destinationFrame) {
            tempRect2.x = renderTexture.frame.x;
            tempRect2.y = renderTexture.frame.y;
            tempRect2.width = sourceFrame.width;
            tempRect2.height = sourceFrame.height;
            destinationFrame = tempRect2;
          }
          framebuffer = baseTexture.framebuffer;
        } else {
          resolution = renderer.resolution;
          if (!sourceFrame) {
            tempRect.width = renderer.screen.width;
            tempRect.height = renderer.screen.height;
            sourceFrame = tempRect;
          }
          if (!destinationFrame) {
            destinationFrame = tempRect;
            destinationFrame.width = sourceFrame.width;
            destinationFrame.height = sourceFrame.height;
          }
        }
        var viewportFrame = this.viewportFrame;
        viewportFrame.x = destinationFrame.x * resolution;
        viewportFrame.y = destinationFrame.y * resolution;
        viewportFrame.width = destinationFrame.width * resolution;
        viewportFrame.height = destinationFrame.height * resolution;
        if (!renderTexture) {
          viewportFrame.y = renderer.view.height - (viewportFrame.y + viewportFrame.height);
        }
        viewportFrame.ceil();
        this.renderer.framebuffer.bind(framebuffer, viewportFrame);
        this.renderer.projection.update(destinationFrame, sourceFrame, resolution, !framebuffer);
        if (renderTexture) {
          this.renderer.mask.setMaskStack(baseTexture.maskStack);
        } else {
          this.renderer.mask.setMaskStack(this.defaultMaskStack);
        }
        this.sourceFrame.copyFrom(sourceFrame);
        this.destinationFrame.copyFrom(destinationFrame);
      };
      RenderTextureSystem2.prototype.clear = function(clearColor, mask) {
        if (this.current) {
          clearColor = clearColor || this.current.baseTexture.clearColor;
        } else {
          clearColor = clearColor || this.clearColor;
        }
        var destinationFrame = this.destinationFrame;
        var baseFrame = this.current ? this.current.baseTexture : this.renderer.screen;
        var clearMask = destinationFrame.width !== baseFrame.width || destinationFrame.height !== baseFrame.height;
        if (clearMask) {
          var _a = this.viewportFrame, x = _a.x, y = _a.y, width = _a.width, height = _a.height;
          x = Math.round(x);
          y = Math.round(y);
          width = Math.round(width);
          height = Math.round(height);
          this.renderer.gl.enable(this.renderer.gl.SCISSOR_TEST);
          this.renderer.gl.scissor(x, y, width, height);
        }
        this.renderer.framebuffer.clear(clearColor[0], clearColor[1], clearColor[2], clearColor[3], mask);
        if (clearMask) {
          this.renderer.scissor.pop();
        }
      };
      RenderTextureSystem2.prototype.resize = function() {
        this.bind(null);
      };
      RenderTextureSystem2.prototype.reset = function() {
        this.bind(null);
      };
      RenderTextureSystem2.prototype.destroy = function() {
        this.renderer = null;
      };
      return RenderTextureSystem2;
    })()
  );
  function uboUpdate(_ud, _uv, _renderer, _syncData, buffer) {
    _renderer.buffer.update(buffer);
  }
  var UBO_TO_SINGLE_SETTERS = {
    float: "\n        data[offset] = v;\n    ",
    vec2: "\n        data[offset] = v[0];\n        data[offset+1] = v[1];\n    ",
    vec3: "\n        data[offset] = v[0];\n        data[offset+1] = v[1];\n        data[offset+2] = v[2];\n\n    ",
    vec4: "\n        data[offset] = v[0];\n        data[offset+1] = v[1];\n        data[offset+2] = v[2];\n        data[offset+3] = v[3];\n    ",
    mat2: "\n        data[offset] = v[0];\n        data[offset+1] = v[1];\n\n        data[offset+4] = v[2];\n        data[offset+5] = v[3];\n    ",
    mat3: "\n        data[offset] = v[0];\n        data[offset+1] = v[1];\n        data[offset+2] = v[2];\n\n        data[offset + 4] = v[3];\n        data[offset + 5] = v[4];\n        data[offset + 6] = v[5];\n\n        data[offset + 8] = v[6];\n        data[offset + 9] = v[7];\n        data[offset + 10] = v[8];\n    ",
    mat4: "\n        for(var i = 0; i < 16; i++)\n        {\n            data[offset + i] = v[i];\n        }\n    "
  };
  var GLSL_TO_STD40_SIZE = {
    float: 4,
    vec2: 8,
    vec3: 12,
    vec4: 16,
    int: 4,
    ivec2: 8,
    ivec3: 12,
    ivec4: 16,
    uint: 4,
    uvec2: 8,
    uvec3: 12,
    uvec4: 16,
    bool: 4,
    bvec2: 8,
    bvec3: 12,
    bvec4: 16,
    mat2: 16 * 2,
    mat3: 16 * 3,
    mat4: 16 * 4
  };
  function createUBOElements(uniformData) {
    var uboElements = uniformData.map(function(data) {
      return {
        data,
        offset: 0,
        dataLen: 0,
        dirty: 0
      };
    });
    var size = 0;
    var chunkSize = 0;
    var offset = 0;
    for (var i = 0; i < uboElements.length; i++) {
      var uboElement = uboElements[i];
      size = GLSL_TO_STD40_SIZE[uboElement.data.type];
      if (uboElement.data.size > 1) {
        size = Math.max(size, 16) * uboElement.data.size;
      }
      uboElement.dataLen = size;
      if (chunkSize % size !== 0 && chunkSize < 16) {
        var lineUpValue = chunkSize % size % 16;
        chunkSize += lineUpValue;
        offset += lineUpValue;
      }
      if (chunkSize + size > 16) {
        offset = Math.ceil(offset / 16) * 16;
        uboElement.offset = offset;
        offset += size;
        chunkSize = size;
      } else {
        uboElement.offset = offset;
        chunkSize += size;
        offset += size;
      }
    }
    offset = Math.ceil(offset / 16) * 16;
    return { uboElements, size: offset };
  }
  function getUBOData(uniforms, uniformData) {
    var usedUniformDatas = [];
    for (var i in uniforms) {
      if (uniformData[i]) {
        usedUniformDatas.push(uniformData[i]);
      }
    }
    usedUniformDatas.sort(function(a, b) {
      return a.index - b.index;
    });
    return usedUniformDatas;
  }
  function generateUniformBufferSync(group, uniformData) {
    if (!group.autoManage) {
      return { size: 0, syncFunc: uboUpdate };
    }
    var usedUniformDatas = getUBOData(group.uniforms, uniformData);
    var _a = createUBOElements(usedUniformDatas), uboElements = _a.uboElements, size = _a.size;
    var funcFragments = ["\n    var v = null;\n    var v2 = null;\n    var cv = null;\n    var t = 0;\n    var gl = renderer.gl\n    var index = 0;\n    var data = buffer.data;\n    "];
    for (var i = 0; i < uboElements.length; i++) {
      var uboElement = uboElements[i];
      var uniform = group.uniforms[uboElement.data.name];
      var name = uboElement.data.name;
      var parsed = false;
      for (var j = 0; j < uniformParsers.length; j++) {
        var uniformParser = uniformParsers[j];
        if (uniformParser.codeUbo && uniformParser.test(uboElement.data, uniform)) {
          funcFragments.push("offset = " + uboElement.offset / 4 + ";", uniformParsers[j].codeUbo(uboElement.data.name, uniform));
          parsed = true;
          break;
        }
      }
      if (!parsed) {
        if (uboElement.data.size > 1) {
          var size_1 = mapSize(uboElement.data.type);
          var rowSize = Math.max(GLSL_TO_STD40_SIZE[uboElement.data.type] / 16, 1);
          var elementSize = size_1 / rowSize;
          var remainder = (4 - elementSize % 4) % 4;
          funcFragments.push("\n                cv = ud." + name + ".value;\n                v = uv." + name + ";\n                offset = " + uboElement.offset / 4 + ";\n\n                t = 0;\n\n                for(var i=0; i < " + uboElement.data.size * rowSize + "; i++)\n                {\n                    for(var j = 0; j < " + elementSize + "; j++)\n                    {\n                        data[offset++] = v[t++];\n                    }\n                    offset += " + remainder + ";\n                }\n\n                ");
        } else {
          var template = UBO_TO_SINGLE_SETTERS[uboElement.data.type];
          funcFragments.push("\n                cv = ud." + name + ".value;\n                v = uv." + name + ";\n                offset = " + uboElement.offset / 4 + ";\n                " + template + ";\n                ");
        }
      }
    }
    funcFragments.push("\n       renderer.buffer.update(buffer);\n    ");
    return {
      size,
      // eslint-disable-next-line no-new-func
      syncFunc: new Function("ud", "uv", "renderer", "syncData", "buffer", funcFragments.join("\n"))
    };
  }
  var GLProgram = (
    /** @class */
    (function() {
      function GLProgram2(program, uniformData) {
        this.program = program;
        this.uniformData = uniformData;
        this.uniformGroups = {};
        this.uniformDirtyGroups = {};
        this.uniformBufferBindings = {};
      }
      GLProgram2.prototype.destroy = function() {
        this.uniformData = null;
        this.uniformGroups = null;
        this.uniformDirtyGroups = null;
        this.uniformBufferBindings = null;
        this.program = null;
      };
      return GLProgram2;
    })()
  );
  function getAttributeData(program, gl) {
    var attributes = {};
    var totalAttributes = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
    for (var i = 0; i < totalAttributes; i++) {
      var attribData = gl.getActiveAttrib(program, i);
      if (attribData.name.indexOf("gl_") === 0) {
        continue;
      }
      var type = mapType(gl, attribData.type);
      var data = {
        type,
        name: attribData.name,
        size: mapSize(type),
        location: gl.getAttribLocation(program, attribData.name)
      };
      attributes[attribData.name] = data;
    }
    return attributes;
  }
  function getUniformData(program, gl) {
    var uniforms = {};
    var totalUniforms = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < totalUniforms; i++) {
      var uniformData = gl.getActiveUniform(program, i);
      var name = uniformData.name.replace(/\[.*?\]$/, "");
      var isArray = !!uniformData.name.match(/\[.*?\]$/);
      var type = mapType(gl, uniformData.type);
      uniforms[name] = {
        name,
        index: i,
        type,
        size: uniformData.size,
        isArray,
        value: defaultValue(type, uniformData.size)
      };
    }
    return uniforms;
  }
  function generateProgram(gl, program) {
    var glVertShader = compileShader(gl, gl.VERTEX_SHADER, program.vertexSrc);
    var glFragShader = compileShader(gl, gl.FRAGMENT_SHADER, program.fragmentSrc);
    var webGLProgram = gl.createProgram();
    gl.attachShader(webGLProgram, glVertShader);
    gl.attachShader(webGLProgram, glFragShader);
    gl.linkProgram(webGLProgram);
    if (!gl.getProgramParameter(webGLProgram, gl.LINK_STATUS)) {
      logProgramError(gl, webGLProgram, glVertShader, glFragShader);
    }
    program.attributeData = getAttributeData(webGLProgram, gl);
    program.uniformData = getUniformData(webGLProgram, gl);
    if (!/^[ \t]*#[ \t]*version[ \t]+300[ \t]+es[ \t]*$/m.test(program.vertexSrc)) {
      var keys = Object.keys(program.attributeData);
      keys.sort(function(a, b) {
        return a > b ? 1 : -1;
      });
      for (var i = 0; i < keys.length; i++) {
        program.attributeData[keys[i]].location = i;
        gl.bindAttribLocation(webGLProgram, i, keys[i]);
      }
      gl.linkProgram(webGLProgram);
    }
    gl.deleteShader(glVertShader);
    gl.deleteShader(glFragShader);
    var uniformData = {};
    for (var i in program.uniformData) {
      var data = program.uniformData[i];
      uniformData[i] = {
        location: gl.getUniformLocation(webGLProgram, i),
        value: defaultValue(data.type, data.size)
      };
    }
    var glProgram = new GLProgram(webGLProgram, uniformData);
    return glProgram;
  }
  var UID = 0;
  var defaultSyncData = { textureCount: 0, uboCount: 0 };
  var ShaderSystem = (
    /** @class */
    (function() {
      function ShaderSystem2(renderer) {
        this.destroyed = false;
        this.renderer = renderer;
        this.systemCheck();
        this.gl = null;
        this.shader = null;
        this.program = null;
        this.cache = {};
        this._uboCache = {};
        this.id = UID++;
      }
      ShaderSystem2.prototype.systemCheck = function() {
        if (!unsafeEvalSupported()) {
          throw new Error("Current environment does not allow unsafe-eval, please use @pixi/unsafe-eval module to enable support.");
        }
      };
      ShaderSystem2.prototype.contextChange = function(gl) {
        this.gl = gl;
        this.reset();
      };
      ShaderSystem2.prototype.bind = function(shader, dontSync) {
        shader.disposeRunner.add(this);
        shader.uniforms.globals = this.renderer.globalUniforms;
        var program = shader.program;
        var glProgram = program.glPrograms[this.renderer.CONTEXT_UID] || this.generateProgram(shader);
        this.shader = shader;
        if (this.program !== program) {
          this.program = program;
          this.gl.useProgram(glProgram.program);
        }
        if (!dontSync) {
          defaultSyncData.textureCount = 0;
          defaultSyncData.uboCount = 0;
          this.syncUniformGroup(shader.uniformGroup, defaultSyncData);
        }
        return glProgram;
      };
      ShaderSystem2.prototype.setUniforms = function(uniforms) {
        var shader = this.shader.program;
        var glProgram = shader.glPrograms[this.renderer.CONTEXT_UID];
        shader.syncUniforms(glProgram.uniformData, uniforms, this.renderer);
      };
      ShaderSystem2.prototype.syncUniformGroup = function(group, syncData) {
        var glProgram = this.getGlProgram();
        if (!group.static || group.dirtyId !== glProgram.uniformDirtyGroups[group.id]) {
          glProgram.uniformDirtyGroups[group.id] = group.dirtyId;
          this.syncUniforms(group, glProgram, syncData);
        }
      };
      ShaderSystem2.prototype.syncUniforms = function(group, glProgram, syncData) {
        var syncFunc = group.syncUniforms[this.shader.program.id] || this.createSyncGroups(group);
        syncFunc(glProgram.uniformData, group.uniforms, this.renderer, syncData);
      };
      ShaderSystem2.prototype.createSyncGroups = function(group) {
        var id = this.getSignature(group, this.shader.program.uniformData, "u");
        if (!this.cache[id]) {
          this.cache[id] = generateUniformsSync(group, this.shader.program.uniformData);
        }
        group.syncUniforms[this.shader.program.id] = this.cache[id];
        return group.syncUniforms[this.shader.program.id];
      };
      ShaderSystem2.prototype.syncUniformBufferGroup = function(group, name) {
        var glProgram = this.getGlProgram();
        if (!group.static || group.dirtyId !== 0 || !glProgram.uniformGroups[group.id]) {
          group.dirtyId = 0;
          var syncFunc = glProgram.uniformGroups[group.id] || this.createSyncBufferGroup(group, glProgram, name);
          group.buffer.update();
          syncFunc(glProgram.uniformData, group.uniforms, this.renderer, defaultSyncData, group.buffer);
        }
        this.renderer.buffer.bindBufferBase(group.buffer, glProgram.uniformBufferBindings[name]);
      };
      ShaderSystem2.prototype.createSyncBufferGroup = function(group, glProgram, name) {
        var gl = this.renderer.gl;
        this.renderer.buffer.bind(group.buffer);
        var uniformBlockIndex = this.gl.getUniformBlockIndex(glProgram.program, name);
        glProgram.uniformBufferBindings[name] = this.shader.uniformBindCount;
        gl.uniformBlockBinding(glProgram.program, uniformBlockIndex, this.shader.uniformBindCount);
        this.shader.uniformBindCount++;
        var id = this.getSignature(group, this.shader.program.uniformData, "ubo");
        var uboData = this._uboCache[id];
        if (!uboData) {
          uboData = this._uboCache[id] = generateUniformBufferSync(group, this.shader.program.uniformData);
        }
        if (group.autoManage) {
          var data = new Float32Array(uboData.size / 4);
          group.buffer.update(data);
        }
        glProgram.uniformGroups[group.id] = uboData.syncFunc;
        return glProgram.uniformGroups[group.id];
      };
      ShaderSystem2.prototype.getSignature = function(group, uniformData, preFix) {
        var uniforms = group.uniforms;
        var strings = [preFix + "-"];
        for (var i in uniforms) {
          strings.push(i);
          if (uniformData[i]) {
            strings.push(uniformData[i].type);
          }
        }
        return strings.join("-");
      };
      ShaderSystem2.prototype.getGlProgram = function() {
        if (this.shader) {
          return this.shader.program.glPrograms[this.renderer.CONTEXT_UID];
        }
        return null;
      };
      ShaderSystem2.prototype.generateProgram = function(shader) {
        var gl = this.gl;
        var program = shader.program;
        var glProgram = generateProgram(gl, program);
        program.glPrograms[this.renderer.CONTEXT_UID] = glProgram;
        return glProgram;
      };
      ShaderSystem2.prototype.reset = function() {
        this.program = null;
        this.shader = null;
      };
      ShaderSystem2.prototype.disposeShader = function(shader) {
        if (this.shader === shader) {
          this.shader = null;
        }
      };
      ShaderSystem2.prototype.destroy = function() {
        this.renderer = null;
        this.destroyed = true;
      };
      return ShaderSystem2;
    })()
  );
  function mapWebGLBlendModesToPixi(gl, array) {
    if (array === void 0) {
      array = [];
    }
    array[BLEND_MODES.NORMAL] = [gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
    array[BLEND_MODES.ADD] = [gl.ONE, gl.ONE];
    array[BLEND_MODES.MULTIPLY] = [gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
    array[BLEND_MODES.SCREEN] = [gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
    array[BLEND_MODES.OVERLAY] = [gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
    array[BLEND_MODES.DARKEN] = [gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
    array[BLEND_MODES.LIGHTEN] = [gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
    array[BLEND_MODES.COLOR_DODGE] = [gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
    array[BLEND_MODES.COLOR_BURN] = [gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
    array[BLEND_MODES.HARD_LIGHT] = [gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
    array[BLEND_MODES.SOFT_LIGHT] = [gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
    array[BLEND_MODES.DIFFERENCE] = [gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
    array[BLEND_MODES.EXCLUSION] = [gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
    array[BLEND_MODES.HUE] = [gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
    array[BLEND_MODES.SATURATION] = [gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
    array[BLEND_MODES.COLOR] = [gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
    array[BLEND_MODES.LUMINOSITY] = [gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
    array[BLEND_MODES.NONE] = [0, 0];
    array[BLEND_MODES.NORMAL_NPM] = [gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
    array[BLEND_MODES.ADD_NPM] = [gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE];
    array[BLEND_MODES.SCREEN_NPM] = [gl.SRC_ALPHA, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
    array[BLEND_MODES.SRC_IN] = [gl.DST_ALPHA, gl.ZERO];
    array[BLEND_MODES.SRC_OUT] = [gl.ONE_MINUS_DST_ALPHA, gl.ZERO];
    array[BLEND_MODES.SRC_ATOP] = [gl.DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA];
    array[BLEND_MODES.DST_OVER] = [gl.ONE_MINUS_DST_ALPHA, gl.ONE];
    array[BLEND_MODES.DST_IN] = [gl.ZERO, gl.SRC_ALPHA];
    array[BLEND_MODES.DST_OUT] = [gl.ZERO, gl.ONE_MINUS_SRC_ALPHA];
    array[BLEND_MODES.DST_ATOP] = [gl.ONE_MINUS_DST_ALPHA, gl.SRC_ALPHA];
    array[BLEND_MODES.XOR] = [gl.ONE_MINUS_DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA];
    array[BLEND_MODES.SUBTRACT] = [gl.ONE, gl.ONE, gl.ONE, gl.ONE, gl.FUNC_REVERSE_SUBTRACT, gl.FUNC_ADD];
    return array;
  }
  var BLEND = 0;
  var OFFSET = 1;
  var CULLING = 2;
  var DEPTH_TEST = 3;
  var WINDING = 4;
  var DEPTH_MASK = 5;
  var StateSystem = (
    /** @class */
    (function() {
      function StateSystem2() {
        this.gl = null;
        this.stateId = 0;
        this.polygonOffset = 0;
        this.blendMode = BLEND_MODES.NONE;
        this._blendEq = false;
        this.map = [];
        this.map[BLEND] = this.setBlend;
        this.map[OFFSET] = this.setOffset;
        this.map[CULLING] = this.setCullFace;
        this.map[DEPTH_TEST] = this.setDepthTest;
        this.map[WINDING] = this.setFrontFace;
        this.map[DEPTH_MASK] = this.setDepthMask;
        this.checks = [];
        this.defaultState = new State();
        this.defaultState.blend = true;
      }
      StateSystem2.prototype.contextChange = function(gl) {
        this.gl = gl;
        this.blendModes = mapWebGLBlendModesToPixi(gl);
        this.set(this.defaultState);
        this.reset();
      };
      StateSystem2.prototype.set = function(state) {
        state = state || this.defaultState;
        if (this.stateId !== state.data) {
          var diff = this.stateId ^ state.data;
          var i = 0;
          while (diff) {
            if (diff & 1) {
              this.map[i].call(this, !!(state.data & 1 << i));
            }
            diff = diff >> 1;
            i++;
          }
          this.stateId = state.data;
        }
        for (var i = 0; i < this.checks.length; i++) {
          this.checks[i](this, state);
        }
      };
      StateSystem2.prototype.forceState = function(state) {
        state = state || this.defaultState;
        for (var i = 0; i < this.map.length; i++) {
          this.map[i].call(this, !!(state.data & 1 << i));
        }
        for (var i = 0; i < this.checks.length; i++) {
          this.checks[i](this, state);
        }
        this.stateId = state.data;
      };
      StateSystem2.prototype.setBlend = function(value) {
        this.updateCheck(StateSystem2.checkBlendMode, value);
        this.gl[value ? "enable" : "disable"](this.gl.BLEND);
      };
      StateSystem2.prototype.setOffset = function(value) {
        this.updateCheck(StateSystem2.checkPolygonOffset, value);
        this.gl[value ? "enable" : "disable"](this.gl.POLYGON_OFFSET_FILL);
      };
      StateSystem2.prototype.setDepthTest = function(value) {
        this.gl[value ? "enable" : "disable"](this.gl.DEPTH_TEST);
      };
      StateSystem2.prototype.setDepthMask = function(value) {
        this.gl.depthMask(value);
      };
      StateSystem2.prototype.setCullFace = function(value) {
        this.gl[value ? "enable" : "disable"](this.gl.CULL_FACE);
      };
      StateSystem2.prototype.setFrontFace = function(value) {
        this.gl.frontFace(this.gl[value ? "CW" : "CCW"]);
      };
      StateSystem2.prototype.setBlendMode = function(value) {
        if (value === this.blendMode) {
          return;
        }
        this.blendMode = value;
        var mode = this.blendModes[value];
        var gl = this.gl;
        if (mode.length === 2) {
          gl.blendFunc(mode[0], mode[1]);
        } else {
          gl.blendFuncSeparate(mode[0], mode[1], mode[2], mode[3]);
        }
        if (mode.length === 6) {
          this._blendEq = true;
          gl.blendEquationSeparate(mode[4], mode[5]);
        } else if (this._blendEq) {
          this._blendEq = false;
          gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
        }
      };
      StateSystem2.prototype.setPolygonOffset = function(value, scale) {
        this.gl.polygonOffset(value, scale);
      };
      StateSystem2.prototype.reset = function() {
        this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, false);
        this.forceState(this.defaultState);
        this._blendEq = true;
        this.blendMode = -1;
        this.setBlendMode(0);
      };
      StateSystem2.prototype.updateCheck = function(func, value) {
        var index = this.checks.indexOf(func);
        if (value && index === -1) {
          this.checks.push(func);
        } else if (!value && index !== -1) {
          this.checks.splice(index, 1);
        }
      };
      StateSystem2.checkBlendMode = function(system, state) {
        system.setBlendMode(state.blendMode);
      };
      StateSystem2.checkPolygonOffset = function(system, state) {
        system.setPolygonOffset(1, state.polygonOffset);
      };
      StateSystem2.prototype.destroy = function() {
        this.gl = null;
      };
      return StateSystem2;
    })()
  );
  var TextureGCSystem = (
    /** @class */
    (function() {
      function TextureGCSystem2(renderer) {
        this.renderer = renderer;
        this.count = 0;
        this.checkCount = 0;
        this.maxIdle = settings.GC_MAX_IDLE;
        this.checkCountMax = settings.GC_MAX_CHECK_COUNT;
        this.mode = settings.GC_MODE;
      }
      TextureGCSystem2.prototype.postrender = function() {
        if (!this.renderer.renderingToScreen) {
          return;
        }
        this.count++;
        if (this.mode === GC_MODES.MANUAL) {
          return;
        }
        this.checkCount++;
        if (this.checkCount > this.checkCountMax) {
          this.checkCount = 0;
          this.run();
        }
      };
      TextureGCSystem2.prototype.run = function() {
        var tm = this.renderer.texture;
        var managedTextures = tm.managedTextures;
        var wasRemoved = false;
        for (var i = 0; i < managedTextures.length; i++) {
          var texture = managedTextures[i];
          if (!texture.framebuffer && this.count - texture.touched > this.maxIdle) {
            tm.destroyTexture(texture, true);
            managedTextures[i] = null;
            wasRemoved = true;
          }
        }
        if (wasRemoved) {
          var j = 0;
          for (var i = 0; i < managedTextures.length; i++) {
            if (managedTextures[i] !== null) {
              managedTextures[j++] = managedTextures[i];
            }
          }
          managedTextures.length = j;
        }
      };
      TextureGCSystem2.prototype.unload = function(displayObject) {
        var tm = this.renderer.texture;
        var texture = displayObject._texture;
        if (texture && !texture.framebuffer) {
          tm.destroyTexture(texture);
        }
        for (var i = displayObject.children.length - 1; i >= 0; i--) {
          this.unload(displayObject.children[i]);
        }
      };
      TextureGCSystem2.prototype.destroy = function() {
        this.renderer = null;
      };
      return TextureGCSystem2;
    })()
  );
  function mapTypeAndFormatToInternalFormat(gl) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x;
    var table;
    if ("WebGL2RenderingContext" in globalThis && gl instanceof globalThis.WebGL2RenderingContext) {
      table = (_a = {}, _a[TYPES.UNSIGNED_BYTE] = (_b = {}, _b[FORMATS.RGBA] = gl.RGBA8, _b[FORMATS.RGB] = gl.RGB8, _b[FORMATS.RG] = gl.RG8, _b[FORMATS.RED] = gl.R8, _b[FORMATS.RGBA_INTEGER] = gl.RGBA8UI, _b[FORMATS.RGB_INTEGER] = gl.RGB8UI, _b[FORMATS.RG_INTEGER] = gl.RG8UI, _b[FORMATS.RED_INTEGER] = gl.R8UI, _b[FORMATS.ALPHA] = gl.ALPHA, _b[FORMATS.LUMINANCE] = gl.LUMINANCE, _b[FORMATS.LUMINANCE_ALPHA] = gl.LUMINANCE_ALPHA, _b), _a[TYPES.BYTE] = (_c = {}, _c[FORMATS.RGBA] = gl.RGBA8_SNORM, _c[FORMATS.RGB] = gl.RGB8_SNORM, _c[FORMATS.RG] = gl.RG8_SNORM, _c[FORMATS.RED] = gl.R8_SNORM, _c[FORMATS.RGBA_INTEGER] = gl.RGBA8I, _c[FORMATS.RGB_INTEGER] = gl.RGB8I, _c[FORMATS.RG_INTEGER] = gl.RG8I, _c[FORMATS.RED_INTEGER] = gl.R8I, _c), _a[TYPES.UNSIGNED_SHORT] = (_d = {}, _d[FORMATS.RGBA_INTEGER] = gl.RGBA16UI, _d[FORMATS.RGB_INTEGER] = gl.RGB16UI, _d[FORMATS.RG_INTEGER] = gl.RG16UI, _d[FORMATS.RED_INTEGER] = gl.R16UI, _d[FORMATS.DEPTH_COMPONENT] = gl.DEPTH_COMPONENT16, _d), _a[TYPES.SHORT] = (_e = {}, _e[FORMATS.RGBA_INTEGER] = gl.RGBA16I, _e[FORMATS.RGB_INTEGER] = gl.RGB16I, _e[FORMATS.RG_INTEGER] = gl.RG16I, _e[FORMATS.RED_INTEGER] = gl.R16I, _e), _a[TYPES.UNSIGNED_INT] = (_f = {}, _f[FORMATS.RGBA_INTEGER] = gl.RGBA32UI, _f[FORMATS.RGB_INTEGER] = gl.RGB32UI, _f[FORMATS.RG_INTEGER] = gl.RG32UI, _f[FORMATS.RED_INTEGER] = gl.R32UI, _f[FORMATS.DEPTH_COMPONENT] = gl.DEPTH_COMPONENT24, _f), _a[TYPES.INT] = (_g = {}, _g[FORMATS.RGBA_INTEGER] = gl.RGBA32I, _g[FORMATS.RGB_INTEGER] = gl.RGB32I, _g[FORMATS.RG_INTEGER] = gl.RG32I, _g[FORMATS.RED_INTEGER] = gl.R32I, _g), _a[TYPES.FLOAT] = (_h = {}, _h[FORMATS.RGBA] = gl.RGBA32F, _h[FORMATS.RGB] = gl.RGB32F, _h[FORMATS.RG] = gl.RG32F, _h[FORMATS.RED] = gl.R32F, _h[FORMATS.DEPTH_COMPONENT] = gl.DEPTH_COMPONENT32F, _h), _a[TYPES.HALF_FLOAT] = (_j = {}, _j[FORMATS.RGBA] = gl.RGBA16F, _j[FORMATS.RGB] = gl.RGB16F, _j[FORMATS.RG] = gl.RG16F, _j[FORMATS.RED] = gl.R16F, _j), _a[TYPES.UNSIGNED_SHORT_5_6_5] = (_k = {}, _k[FORMATS.RGB] = gl.RGB565, _k), _a[TYPES.UNSIGNED_SHORT_4_4_4_4] = (_l = {}, _l[FORMATS.RGBA] = gl.RGBA4, _l), _a[TYPES.UNSIGNED_SHORT_5_5_5_1] = (_m = {}, _m[FORMATS.RGBA] = gl.RGB5_A1, _m), _a[TYPES.UNSIGNED_INT_2_10_10_10_REV] = (_o = {}, _o[FORMATS.RGBA] = gl.RGB10_A2, _o[FORMATS.RGBA_INTEGER] = gl.RGB10_A2UI, _o), _a[TYPES.UNSIGNED_INT_10F_11F_11F_REV] = (_p = {}, _p[FORMATS.RGB] = gl.R11F_G11F_B10F, _p), _a[TYPES.UNSIGNED_INT_5_9_9_9_REV] = (_q = {}, _q[FORMATS.RGB] = gl.RGB9_E5, _q), _a[TYPES.UNSIGNED_INT_24_8] = (_r = {}, _r[FORMATS.DEPTH_STENCIL] = gl.DEPTH24_STENCIL8, _r), _a[TYPES.FLOAT_32_UNSIGNED_INT_24_8_REV] = (_s = {}, _s[FORMATS.DEPTH_STENCIL] = gl.DEPTH32F_STENCIL8, _s), _a);
    } else {
      table = (_t = {}, _t[TYPES.UNSIGNED_BYTE] = (_u = {}, _u[FORMATS.RGBA] = gl.RGBA, _u[FORMATS.RGB] = gl.RGB, _u[FORMATS.ALPHA] = gl.ALPHA, _u[FORMATS.LUMINANCE] = gl.LUMINANCE, _u[FORMATS.LUMINANCE_ALPHA] = gl.LUMINANCE_ALPHA, _u), _t[TYPES.UNSIGNED_SHORT_5_6_5] = (_v = {}, _v[FORMATS.RGB] = gl.RGB, _v), _t[TYPES.UNSIGNED_SHORT_4_4_4_4] = (_w = {}, _w[FORMATS.RGBA] = gl.RGBA, _w), _t[TYPES.UNSIGNED_SHORT_5_5_5_1] = (_x = {}, _x[FORMATS.RGBA] = gl.RGBA, _x), _t);
    }
    return table;
  }
  var GLTexture = (
    /** @class */
    /* @__PURE__ */ (function() {
      function GLTexture2(texture) {
        this.texture = texture;
        this.width = -1;
        this.height = -1;
        this.dirtyId = -1;
        this.dirtyStyleId = -1;
        this.mipmap = false;
        this.wrapMode = 33071;
        this.type = TYPES.UNSIGNED_BYTE;
        this.internalFormat = FORMATS.RGBA;
        this.samplerType = 0;
      }
      return GLTexture2;
    })()
  );
  var TextureSystem = (
    /** @class */
    (function() {
      function TextureSystem2(renderer) {
        this.renderer = renderer;
        this.boundTextures = [];
        this.currentLocation = -1;
        this.managedTextures = [];
        this._unknownBoundTextures = false;
        this.unknownTexture = new BaseTexture();
        this.hasIntegerTextures = false;
      }
      TextureSystem2.prototype.contextChange = function() {
        var gl = this.gl = this.renderer.gl;
        this.CONTEXT_UID = this.renderer.CONTEXT_UID;
        this.webGLVersion = this.renderer.context.webGLVersion;
        this.internalFormats = mapTypeAndFormatToInternalFormat(gl);
        var maxTextures = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
        this.boundTextures.length = maxTextures;
        for (var i = 0; i < maxTextures; i++) {
          this.boundTextures[i] = null;
        }
        this.emptyTextures = {};
        var emptyTexture2D = new GLTexture(gl.createTexture());
        gl.bindTexture(gl.TEXTURE_2D, emptyTexture2D.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
        this.emptyTextures[gl.TEXTURE_2D] = emptyTexture2D;
        this.emptyTextures[gl.TEXTURE_CUBE_MAP] = new GLTexture(gl.createTexture());
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.emptyTextures[gl.TEXTURE_CUBE_MAP].texture);
        for (var i = 0; i < 6; i++) {
          gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        }
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        for (var i = 0; i < this.boundTextures.length; i++) {
          this.bind(null, i);
        }
      };
      TextureSystem2.prototype.bind = function(texture, location) {
        if (location === void 0) {
          location = 0;
        }
        var gl = this.gl;
        texture = texture === null || texture === void 0 ? void 0 : texture.castToBaseTexture();
        if (texture && texture.valid && !texture.parentTextureArray) {
          texture.touched = this.renderer.textureGC.count;
          var glTexture = texture._glTextures[this.CONTEXT_UID] || this.initTexture(texture);
          if (this.boundTextures[location] !== texture) {
            if (this.currentLocation !== location) {
              this.currentLocation = location;
              gl.activeTexture(gl.TEXTURE0 + location);
            }
            gl.bindTexture(texture.target, glTexture.texture);
          }
          if (glTexture.dirtyId !== texture.dirtyId) {
            if (this.currentLocation !== location) {
              this.currentLocation = location;
              gl.activeTexture(gl.TEXTURE0 + location);
            }
            this.updateTexture(texture);
          } else if (glTexture.dirtyStyleId !== texture.dirtyStyleId) {
            this.updateTextureStyle(texture);
          }
          this.boundTextures[location] = texture;
        } else {
          if (this.currentLocation !== location) {
            this.currentLocation = location;
            gl.activeTexture(gl.TEXTURE0 + location);
          }
          gl.bindTexture(gl.TEXTURE_2D, this.emptyTextures[gl.TEXTURE_2D].texture);
          this.boundTextures[location] = null;
        }
      };
      TextureSystem2.prototype.reset = function() {
        this._unknownBoundTextures = true;
        this.hasIntegerTextures = false;
        this.currentLocation = -1;
        for (var i = 0; i < this.boundTextures.length; i++) {
          this.boundTextures[i] = this.unknownTexture;
        }
      };
      TextureSystem2.prototype.unbind = function(texture) {
        var _a = this, gl = _a.gl, boundTextures = _a.boundTextures;
        if (this._unknownBoundTextures) {
          this._unknownBoundTextures = false;
          for (var i = 0; i < boundTextures.length; i++) {
            if (boundTextures[i] === this.unknownTexture) {
              this.bind(null, i);
            }
          }
        }
        for (var i = 0; i < boundTextures.length; i++) {
          if (boundTextures[i] === texture) {
            if (this.currentLocation !== i) {
              gl.activeTexture(gl.TEXTURE0 + i);
              this.currentLocation = i;
            }
            gl.bindTexture(texture.target, this.emptyTextures[texture.target].texture);
            boundTextures[i] = null;
          }
        }
      };
      TextureSystem2.prototype.ensureSamplerType = function(maxTextures) {
        var _a = this, boundTextures = _a.boundTextures, hasIntegerTextures = _a.hasIntegerTextures, CONTEXT_UID = _a.CONTEXT_UID;
        if (!hasIntegerTextures) {
          return;
        }
        for (var i = maxTextures - 1; i >= 0; --i) {
          var tex = boundTextures[i];
          if (tex) {
            var glTexture = tex._glTextures[CONTEXT_UID];
            if (glTexture.samplerType !== SAMPLER_TYPES.FLOAT) {
              this.renderer.texture.unbind(tex);
            }
          }
        }
      };
      TextureSystem2.prototype.initTexture = function(texture) {
        var glTexture = new GLTexture(this.gl.createTexture());
        glTexture.dirtyId = -1;
        texture._glTextures[this.CONTEXT_UID] = glTexture;
        this.managedTextures.push(texture);
        texture.on("dispose", this.destroyTexture, this);
        return glTexture;
      };
      TextureSystem2.prototype.initTextureType = function(texture, glTexture) {
        var _a, _b;
        glTexture.internalFormat = (_b = (_a = this.internalFormats[texture.type]) === null || _a === void 0 ? void 0 : _a[texture.format]) !== null && _b !== void 0 ? _b : texture.format;
        if (this.webGLVersion === 2 && texture.type === TYPES.HALF_FLOAT) {
          glTexture.type = this.gl.HALF_FLOAT;
        } else {
          glTexture.type = texture.type;
        }
      };
      TextureSystem2.prototype.updateTexture = function(texture) {
        var glTexture = texture._glTextures[this.CONTEXT_UID];
        if (!glTexture) {
          return;
        }
        var renderer = this.renderer;
        this.initTextureType(texture, glTexture);
        if (texture.resource && texture.resource.upload(renderer, texture, glTexture)) {
          if (glTexture.samplerType !== SAMPLER_TYPES.FLOAT) {
            this.hasIntegerTextures = true;
          }
        } else {
          var width = texture.realWidth;
          var height = texture.realHeight;
          var gl = renderer.gl;
          if (glTexture.width !== width || glTexture.height !== height || glTexture.dirtyId < 0) {
            glTexture.width = width;
            glTexture.height = height;
            gl.texImage2D(texture.target, 0, glTexture.internalFormat, width, height, 0, texture.format, glTexture.type, null);
          }
        }
        if (texture.dirtyStyleId !== glTexture.dirtyStyleId) {
          this.updateTextureStyle(texture);
        }
        glTexture.dirtyId = texture.dirtyId;
      };
      TextureSystem2.prototype.destroyTexture = function(texture, skipRemove) {
        var gl = this.gl;
        texture = texture.castToBaseTexture();
        if (texture._glTextures[this.CONTEXT_UID]) {
          this.unbind(texture);
          gl.deleteTexture(texture._glTextures[this.CONTEXT_UID].texture);
          texture.off("dispose", this.destroyTexture, this);
          delete texture._glTextures[this.CONTEXT_UID];
          if (!skipRemove) {
            var i = this.managedTextures.indexOf(texture);
            if (i !== -1) {
              removeItems(this.managedTextures, i, 1);
            }
          }
        }
      };
      TextureSystem2.prototype.updateTextureStyle = function(texture) {
        var glTexture = texture._glTextures[this.CONTEXT_UID];
        if (!glTexture) {
          return;
        }
        if ((texture.mipmap === MIPMAP_MODES.POW2 || this.webGLVersion !== 2) && !texture.isPowerOfTwo) {
          glTexture.mipmap = false;
        } else {
          glTexture.mipmap = texture.mipmap >= 1;
        }
        if (this.webGLVersion !== 2 && !texture.isPowerOfTwo) {
          glTexture.wrapMode = WRAP_MODES.CLAMP;
        } else {
          glTexture.wrapMode = texture.wrapMode;
        }
        if (texture.resource && texture.resource.style(this.renderer, texture, glTexture)) ;
        else {
          this.setStyle(texture, glTexture);
        }
        glTexture.dirtyStyleId = texture.dirtyStyleId;
      };
      TextureSystem2.prototype.setStyle = function(texture, glTexture) {
        var gl = this.gl;
        if (glTexture.mipmap && texture.mipmap !== MIPMAP_MODES.ON_MANUAL) {
          gl.generateMipmap(texture.target);
        }
        gl.texParameteri(texture.target, gl.TEXTURE_WRAP_S, glTexture.wrapMode);
        gl.texParameteri(texture.target, gl.TEXTURE_WRAP_T, glTexture.wrapMode);
        if (glTexture.mipmap) {
          gl.texParameteri(texture.target, gl.TEXTURE_MIN_FILTER, texture.scaleMode === SCALE_MODES.LINEAR ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST);
          var anisotropicExt = this.renderer.context.extensions.anisotropicFiltering;
          if (anisotropicExt && texture.anisotropicLevel > 0 && texture.scaleMode === SCALE_MODES.LINEAR) {
            var level = Math.min(texture.anisotropicLevel, gl.getParameter(anisotropicExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT));
            gl.texParameterf(texture.target, anisotropicExt.TEXTURE_MAX_ANISOTROPY_EXT, level);
          }
        } else {
          gl.texParameteri(texture.target, gl.TEXTURE_MIN_FILTER, texture.scaleMode === SCALE_MODES.LINEAR ? gl.LINEAR : gl.NEAREST);
        }
        gl.texParameteri(texture.target, gl.TEXTURE_MAG_FILTER, texture.scaleMode === SCALE_MODES.LINEAR ? gl.LINEAR : gl.NEAREST);
      };
      TextureSystem2.prototype.destroy = function() {
        this.renderer = null;
      };
      return TextureSystem2;
    })()
  );
  var _systems = {
    __proto__: null,
    FilterSystem,
    BatchSystem,
    ContextSystem,
    FramebufferSystem,
    GeometrySystem,
    MaskSystem,
    ScissorSystem,
    StencilSystem,
    ProjectionSystem,
    RenderTextureSystem,
    ShaderSystem,
    StateSystem,
    TextureGCSystem,
    TextureSystem
  };
  var tempMatrix = new Matrix();
  var AbstractRenderer = (
    /** @class */
    (function(_super) {
      __extends(AbstractRenderer2, _super);
      function AbstractRenderer2(type, options) {
        if (type === void 0) {
          type = RENDERER_TYPE.UNKNOWN;
        }
        var _this = _super.call(this) || this;
        options = Object.assign({}, settings.RENDER_OPTIONS, options);
        _this.options = options;
        _this.type = type;
        _this.screen = new Rectangle(0, 0, options.width, options.height);
        _this.view = options.view || settings.ADAPTER.createCanvas();
        _this.resolution = options.resolution || settings.RESOLUTION;
        _this.useContextAlpha = options.useContextAlpha;
        _this.autoDensity = !!options.autoDensity;
        _this.preserveDrawingBuffer = options.preserveDrawingBuffer;
        _this.clearBeforeRender = options.clearBeforeRender;
        _this._backgroundColor = 0;
        _this._backgroundColorRgba = [0, 0, 0, 1];
        _this._backgroundColorString = "#000000";
        _this.backgroundColor = options.backgroundColor || _this._backgroundColor;
        _this.backgroundAlpha = options.backgroundAlpha;
        if (options.transparent !== void 0) {
          deprecation("6.0.0", "Option transparent is deprecated, please use backgroundAlpha instead.");
          _this.useContextAlpha = options.transparent;
          _this.backgroundAlpha = options.transparent ? 0 : 1;
        }
        _this._lastObjectRendered = null;
        _this.plugins = {};
        return _this;
      }
      AbstractRenderer2.prototype.initPlugins = function(staticMap) {
        for (var o in staticMap) {
          this.plugins[o] = new staticMap[o](this);
        }
      };
      Object.defineProperty(AbstractRenderer2.prototype, "width", {
        /**
         * Same as view.width, actual number of pixels in the canvas by horizontal.
         * @member {number}
         * @readonly
         * @default 800
         */
        get: function() {
          return this.view.width;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(AbstractRenderer2.prototype, "height", {
        /**
         * Same as view.height, actual number of pixels in the canvas by vertical.
         * @member {number}
         * @readonly
         * @default 600
         */
        get: function() {
          return this.view.height;
        },
        enumerable: false,
        configurable: true
      });
      AbstractRenderer2.prototype.resize = function(desiredScreenWidth, desiredScreenHeight) {
        this.view.width = Math.round(desiredScreenWidth * this.resolution);
        this.view.height = Math.round(desiredScreenHeight * this.resolution);
        var screenWidth = this.view.width / this.resolution;
        var screenHeight = this.view.height / this.resolution;
        this.screen.width = screenWidth;
        this.screen.height = screenHeight;
        if (this.autoDensity) {
          this.view.style.width = screenWidth + "px";
          this.view.style.height = screenHeight + "px";
        }
        this.emit("resize", screenWidth, screenHeight);
      };
      AbstractRenderer2.prototype.generateTexture = function(displayObject, options, resolution, region) {
        if (options === void 0) {
          options = {};
        }
        if (typeof options === "number") {
          deprecation("6.1.0", "generateTexture options (scaleMode, resolution, region) are now object options.");
          options = { scaleMode: options, resolution, region };
        }
        var manualRegion = options.region, textureOptions = __rest(options, ["region"]);
        region = manualRegion || displayObject.getLocalBounds(null, true);
        if (region.width === 0) {
          region.width = 1;
        }
        if (region.height === 0) {
          region.height = 1;
        }
        var renderTexture = RenderTexture.create(__assign2({ width: region.width, height: region.height }, textureOptions));
        tempMatrix.tx = -region.x;
        tempMatrix.ty = -region.y;
        this.render(displayObject, {
          renderTexture,
          clear: false,
          transform: tempMatrix,
          skipUpdateTransform: !!displayObject.parent
        });
        return renderTexture;
      };
      AbstractRenderer2.prototype.destroy = function(removeView) {
        for (var o in this.plugins) {
          this.plugins[o].destroy();
          this.plugins[o] = null;
        }
        if (removeView && this.view.parentNode) {
          this.view.parentNode.removeChild(this.view);
        }
        var thisAny = this;
        thisAny.plugins = null;
        thisAny.type = RENDERER_TYPE.UNKNOWN;
        thisAny.view = null;
        thisAny.screen = null;
        thisAny._tempDisplayObjectParent = null;
        thisAny.options = null;
        this._backgroundColorRgba = null;
        this._backgroundColorString = null;
        this._lastObjectRendered = null;
      };
      Object.defineProperty(AbstractRenderer2.prototype, "backgroundColor", {
        /**
         * The background color to fill if not transparent
         * @member {number}
         */
        get: function() {
          return this._backgroundColor;
        },
        set: function(value) {
          this._backgroundColor = value;
          this._backgroundColorString = hex2string(value);
          hex2rgb(value, this._backgroundColorRgba);
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(AbstractRenderer2.prototype, "backgroundAlpha", {
        /**
         * The background color alpha. Setting this to 0 will make the canvas transparent.
         * @member {number}
         */
        get: function() {
          return this._backgroundColorRgba[3];
        },
        set: function(value) {
          this._backgroundColorRgba[3] = value;
        },
        enumerable: false,
        configurable: true
      });
      return AbstractRenderer2;
    })(import_eventemitter3.default)
  );
  var GLBuffer = (
    /** @class */
    /* @__PURE__ */ (function() {
      function GLBuffer2(buffer) {
        this.buffer = buffer || null;
        this.updateID = -1;
        this.byteLength = -1;
        this.refCount = 0;
      }
      return GLBuffer2;
    })()
  );
  var BufferSystem = (
    /** @class */
    (function() {
      function BufferSystem2(renderer) {
        this.renderer = renderer;
        this.managedBuffers = {};
        this.boundBufferBases = {};
      }
      BufferSystem2.prototype.destroy = function() {
        this.renderer = null;
      };
      BufferSystem2.prototype.contextChange = function() {
        this.disposeAll(true);
        this.gl = this.renderer.gl;
        this.CONTEXT_UID = this.renderer.CONTEXT_UID;
      };
      BufferSystem2.prototype.bind = function(buffer) {
        var _a = this, gl = _a.gl, CONTEXT_UID = _a.CONTEXT_UID;
        var glBuffer = buffer._glBuffers[CONTEXT_UID] || this.createGLBuffer(buffer);
        gl.bindBuffer(buffer.type, glBuffer.buffer);
      };
      BufferSystem2.prototype.bindBufferBase = function(buffer, index) {
        var _a = this, gl = _a.gl, CONTEXT_UID = _a.CONTEXT_UID;
        if (this.boundBufferBases[index] !== buffer) {
          var glBuffer = buffer._glBuffers[CONTEXT_UID] || this.createGLBuffer(buffer);
          this.boundBufferBases[index] = buffer;
          gl.bindBufferBase(gl.UNIFORM_BUFFER, index, glBuffer.buffer);
        }
      };
      BufferSystem2.prototype.bindBufferRange = function(buffer, index, offset) {
        var _a = this, gl = _a.gl, CONTEXT_UID = _a.CONTEXT_UID;
        offset = offset || 0;
        var glBuffer = buffer._glBuffers[CONTEXT_UID] || this.createGLBuffer(buffer);
        gl.bindBufferRange(gl.UNIFORM_BUFFER, index || 0, glBuffer.buffer, offset * 256, 256);
      };
      BufferSystem2.prototype.update = function(buffer) {
        var _a = this, gl = _a.gl, CONTEXT_UID = _a.CONTEXT_UID;
        var glBuffer = buffer._glBuffers[CONTEXT_UID];
        if (buffer._updateID === glBuffer.updateID) {
          return;
        }
        glBuffer.updateID = buffer._updateID;
        gl.bindBuffer(buffer.type, glBuffer.buffer);
        if (glBuffer.byteLength >= buffer.data.byteLength) {
          gl.bufferSubData(buffer.type, 0, buffer.data);
        } else {
          var drawType = buffer.static ? gl.STATIC_DRAW : gl.DYNAMIC_DRAW;
          glBuffer.byteLength = buffer.data.byteLength;
          gl.bufferData(buffer.type, buffer.data, drawType);
        }
      };
      BufferSystem2.prototype.dispose = function(buffer, contextLost) {
        if (!this.managedBuffers[buffer.id]) {
          return;
        }
        delete this.managedBuffers[buffer.id];
        var glBuffer = buffer._glBuffers[this.CONTEXT_UID];
        var gl = this.gl;
        buffer.disposeRunner.remove(this);
        if (!glBuffer) {
          return;
        }
        if (!contextLost) {
          gl.deleteBuffer(glBuffer.buffer);
        }
        delete buffer._glBuffers[this.CONTEXT_UID];
      };
      BufferSystem2.prototype.disposeAll = function(contextLost) {
        var all = Object.keys(this.managedBuffers);
        for (var i = 0; i < all.length; i++) {
          this.dispose(this.managedBuffers[all[i]], contextLost);
        }
      };
      BufferSystem2.prototype.createGLBuffer = function(buffer) {
        var _a = this, CONTEXT_UID = _a.CONTEXT_UID, gl = _a.gl;
        buffer._glBuffers[CONTEXT_UID] = new GLBuffer(gl.createBuffer());
        this.managedBuffers[buffer.id] = buffer;
        buffer.disposeRunner.add(this);
        return buffer._glBuffers[CONTEXT_UID];
      };
      return BufferSystem2;
    })()
  );
  var Renderer = (
    /** @class */
    (function(_super) {
      __extends(Renderer2, _super);
      function Renderer2(options) {
        var _this = _super.call(this, RENDERER_TYPE.WEBGL, options) || this;
        options = _this.options;
        _this.gl = null;
        _this.CONTEXT_UID = 0;
        _this.runners = {
          destroy: new Runner("destroy"),
          contextChange: new Runner("contextChange"),
          reset: new Runner("reset"),
          update: new Runner("update"),
          postrender: new Runner("postrender"),
          prerender: new Runner("prerender"),
          resize: new Runner("resize")
        };
        _this.runners.contextChange.add(_this);
        _this.globalUniforms = new UniformGroup({
          projectionMatrix: new Matrix()
        }, true);
        _this.addSystem(MaskSystem, "mask").addSystem(ContextSystem, "context").addSystem(StateSystem, "state").addSystem(ShaderSystem, "shader").addSystem(TextureSystem, "texture").addSystem(BufferSystem, "buffer").addSystem(GeometrySystem, "geometry").addSystem(FramebufferSystem, "framebuffer").addSystem(ScissorSystem, "scissor").addSystem(StencilSystem, "stencil").addSystem(ProjectionSystem, "projection").addSystem(TextureGCSystem, "textureGC").addSystem(FilterSystem, "filter").addSystem(RenderTextureSystem, "renderTexture").addSystem(BatchSystem, "batch");
        _this.initPlugins(Renderer2.__plugins);
        _this.multisample = void 0;
        if (options.context) {
          _this.context.initFromContext(options.context);
        } else {
          _this.context.initFromOptions({
            alpha: !!_this.useContextAlpha,
            antialias: options.antialias,
            premultipliedAlpha: _this.useContextAlpha && _this.useContextAlpha !== "notMultiplied",
            stencil: true,
            preserveDrawingBuffer: options.preserveDrawingBuffer,
            powerPreference: _this.options.powerPreference
          });
        }
        _this.renderingToScreen = true;
        sayHello(_this.context.webGLVersion === 2 ? "WebGL 2" : "WebGL 1");
        _this.resize(_this.options.width, _this.options.height);
        return _this;
      }
      Renderer2.create = function(options) {
        if (isWebGLSupported()) {
          return new Renderer2(options);
        }
        throw new Error('WebGL unsupported in this browser, use "pixi.js-legacy" for fallback canvas2d support.');
      };
      Renderer2.prototype.contextChange = function() {
        var gl = this.gl;
        var samples;
        if (this.context.webGLVersion === 1) {
          var framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          samples = gl.getParameter(gl.SAMPLES);
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        } else {
          var framebuffer = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
          samples = gl.getParameter(gl.SAMPLES);
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer);
        }
        if (samples >= MSAA_QUALITY.HIGH) {
          this.multisample = MSAA_QUALITY.HIGH;
        } else if (samples >= MSAA_QUALITY.MEDIUM) {
          this.multisample = MSAA_QUALITY.MEDIUM;
        } else if (samples >= MSAA_QUALITY.LOW) {
          this.multisample = MSAA_QUALITY.LOW;
        } else {
          this.multisample = MSAA_QUALITY.NONE;
        }
      };
      Renderer2.prototype.addSystem = function(ClassRef, name) {
        var system = new ClassRef(this);
        if (this[name]) {
          throw new Error('Whoops! The name "' + name + '" is already in use');
        }
        this[name] = system;
        for (var i in this.runners) {
          this.runners[i].add(system);
        }
        return this;
      };
      Renderer2.prototype.render = function(displayObject, options) {
        var renderTexture;
        var clear;
        var transform;
        var skipUpdateTransform;
        if (options) {
          if (options instanceof RenderTexture) {
            deprecation("6.0.0", "Renderer#render arguments changed, use options instead.");
            renderTexture = options;
            clear = arguments[2];
            transform = arguments[3];
            skipUpdateTransform = arguments[4];
          } else {
            renderTexture = options.renderTexture;
            clear = options.clear;
            transform = options.transform;
            skipUpdateTransform = options.skipUpdateTransform;
          }
        }
        this.renderingToScreen = !renderTexture;
        this.runners.prerender.emit();
        this.emit("prerender");
        this.projection.transform = transform;
        if (this.context.isLost) {
          return;
        }
        if (!renderTexture) {
          this._lastObjectRendered = displayObject;
        }
        if (!skipUpdateTransform) {
          var cacheParent = displayObject.enableTempParent();
          displayObject.updateTransform();
          displayObject.disableTempParent(cacheParent);
        }
        this.renderTexture.bind(renderTexture);
        this.batch.currentRenderer.start();
        if (clear !== void 0 ? clear : this.clearBeforeRender) {
          this.renderTexture.clear();
        }
        displayObject.render(this);
        this.batch.currentRenderer.flush();
        if (renderTexture) {
          renderTexture.baseTexture.update();
        }
        this.runners.postrender.emit();
        this.projection.transform = null;
        this.emit("postrender");
      };
      Renderer2.prototype.generateTexture = function(displayObject, options, resolution, region) {
        if (options === void 0) {
          options = {};
        }
        var renderTexture = _super.prototype.generateTexture.call(this, displayObject, options, resolution, region);
        this.framebuffer.blit();
        return renderTexture;
      };
      Renderer2.prototype.resize = function(desiredScreenWidth, desiredScreenHeight) {
        _super.prototype.resize.call(this, desiredScreenWidth, desiredScreenHeight);
        this.runners.resize.emit(this.screen.height, this.screen.width);
      };
      Renderer2.prototype.reset = function() {
        this.runners.reset.emit();
        return this;
      };
      Renderer2.prototype.clear = function() {
        this.renderTexture.bind();
        this.renderTexture.clear();
      };
      Renderer2.prototype.destroy = function(removeView) {
        this.runners.destroy.emit();
        for (var r in this.runners) {
          this.runners[r].destroy();
        }
        _super.prototype.destroy.call(this, removeView);
        this.gl = null;
      };
      Object.defineProperty(Renderer2.prototype, "extract", {
        /**
         * Please use `plugins.extract` instead.
         * @member {PIXI.Extract} extract
         * @deprecated since 6.0.0
         * @readonly
         */
        get: function() {
          deprecation("6.0.0", "Renderer#extract has been deprecated, please use Renderer#plugins.extract instead.");
          return this.plugins.extract;
        },
        enumerable: false,
        configurable: true
      });
      Renderer2.registerPlugin = function(pluginName, ctor) {
        deprecation("6.5.0", "Renderer.registerPlugin() has been deprecated, please use extensions.add() instead.");
        extensions.add({
          name: pluginName,
          type: ExtensionType.RendererPlugin,
          ref: ctor
        });
      };
      Renderer2.__plugins = {};
      return Renderer2;
    })(AbstractRenderer)
  );
  extensions.handleByMap(ExtensionType.RendererPlugin, Renderer.__plugins);
  function autoDetectRenderer(options) {
    return Renderer.create(options);
  }
  var System = (
    /** @class */
    (function() {
      function System2(renderer) {
        deprecation("6.1.0", "System class is deprecated, implemement ISystem interface instead.");
        this.renderer = renderer;
      }
      System2.prototype.destroy = function() {
        this.renderer = null;
      };
      return System2;
    })()
  );
  var BatchDrawCall = (
    /** @class */
    /* @__PURE__ */ (function() {
      function BatchDrawCall2() {
        this.texArray = null;
        this.blend = 0;
        this.type = DRAW_MODES.TRIANGLES;
        this.start = 0;
        this.size = 0;
        this.data = null;
      }
      return BatchDrawCall2;
    })()
  );
  var BatchTextureArray = (
    /** @class */
    (function() {
      function BatchTextureArray2() {
        this.elements = [];
        this.ids = [];
        this.count = 0;
      }
      BatchTextureArray2.prototype.clear = function() {
        for (var i = 0; i < this.count; i++) {
          this.elements[i] = null;
        }
        this.count = 0;
      };
      return BatchTextureArray2;
    })()
  );
  var ViewableBuffer = (
    /** @class */
    (function() {
      function ViewableBuffer2(sizeOrBuffer) {
        if (typeof sizeOrBuffer === "number") {
          this.rawBinaryData = new ArrayBuffer(sizeOrBuffer);
        } else if (sizeOrBuffer instanceof Uint8Array) {
          this.rawBinaryData = sizeOrBuffer.buffer;
        } else {
          this.rawBinaryData = sizeOrBuffer;
        }
        this.uint32View = new Uint32Array(this.rawBinaryData);
        this.float32View = new Float32Array(this.rawBinaryData);
      }
      Object.defineProperty(ViewableBuffer2.prototype, "int8View", {
        /** View on the raw binary data as a `Int8Array`. */
        get: function() {
          if (!this._int8View) {
            this._int8View = new Int8Array(this.rawBinaryData);
          }
          return this._int8View;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(ViewableBuffer2.prototype, "uint8View", {
        /** View on the raw binary data as a `Uint8Array`. */
        get: function() {
          if (!this._uint8View) {
            this._uint8View = new Uint8Array(this.rawBinaryData);
          }
          return this._uint8View;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(ViewableBuffer2.prototype, "int16View", {
        /**  View on the raw binary data as a `Int16Array`. */
        get: function() {
          if (!this._int16View) {
            this._int16View = new Int16Array(this.rawBinaryData);
          }
          return this._int16View;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(ViewableBuffer2.prototype, "uint16View", {
        /** View on the raw binary data as a `Uint16Array`. */
        get: function() {
          if (!this._uint16View) {
            this._uint16View = new Uint16Array(this.rawBinaryData);
          }
          return this._uint16View;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(ViewableBuffer2.prototype, "int32View", {
        /** View on the raw binary data as a `Int32Array`. */
        get: function() {
          if (!this._int32View) {
            this._int32View = new Int32Array(this.rawBinaryData);
          }
          return this._int32View;
        },
        enumerable: false,
        configurable: true
      });
      ViewableBuffer2.prototype.view = function(type) {
        return this[type + "View"];
      };
      ViewableBuffer2.prototype.destroy = function() {
        this.rawBinaryData = null;
        this._int8View = null;
        this._uint8View = null;
        this._int16View = null;
        this._uint16View = null;
        this._int32View = null;
        this.uint32View = null;
        this.float32View = null;
      };
      ViewableBuffer2.sizeOf = function(type) {
        switch (type) {
          case "int8":
          case "uint8":
            return 1;
          case "int16":
          case "uint16":
            return 2;
          case "int32":
          case "uint32":
          case "float32":
            return 4;
          default:
            throw new Error(type + " isn't a valid view type");
        }
      };
      return ViewableBuffer2;
    })()
  );
  var AbstractBatchRenderer = (
    /** @class */
    (function(_super) {
      __extends(AbstractBatchRenderer2, _super);
      function AbstractBatchRenderer2(renderer) {
        var _this = _super.call(this, renderer) || this;
        _this.shaderGenerator = null;
        _this.geometryClass = null;
        _this.vertexSize = null;
        _this.state = State.for2d();
        _this.size = settings.SPRITE_BATCH_SIZE * 4;
        _this._vertexCount = 0;
        _this._indexCount = 0;
        _this._bufferedElements = [];
        _this._bufferedTextures = [];
        _this._bufferSize = 0;
        _this._shader = null;
        _this._packedGeometries = [];
        _this._packedGeometryPoolSize = 2;
        _this._flushId = 0;
        _this._aBuffers = {};
        _this._iBuffers = {};
        _this.MAX_TEXTURES = 1;
        _this.renderer.on("prerender", _this.onPrerender, _this);
        renderer.runners.contextChange.add(_this);
        _this._dcIndex = 0;
        _this._aIndex = 0;
        _this._iIndex = 0;
        _this._attributeBuffer = null;
        _this._indexBuffer = null;
        _this._tempBoundTextures = [];
        return _this;
      }
      AbstractBatchRenderer2.prototype.contextChange = function() {
        var gl = this.renderer.gl;
        if (settings.PREFER_ENV === ENV.WEBGL_LEGACY) {
          this.MAX_TEXTURES = 1;
        } else {
          this.MAX_TEXTURES = Math.min(gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS), settings.SPRITE_MAX_TEXTURES);
          this.MAX_TEXTURES = checkMaxIfStatementsInShader(this.MAX_TEXTURES, gl);
        }
        this._shader = this.shaderGenerator.generateShader(this.MAX_TEXTURES);
        for (var i = 0; i < this._packedGeometryPoolSize; i++) {
          this._packedGeometries[i] = new this.geometryClass();
        }
        this.initFlushBuffers();
      };
      AbstractBatchRenderer2.prototype.initFlushBuffers = function() {
        var _drawCallPool = AbstractBatchRenderer2._drawCallPool, _textureArrayPool = AbstractBatchRenderer2._textureArrayPool;
        var MAX_SPRITES = this.size / 4;
        var MAX_TA = Math.floor(MAX_SPRITES / this.MAX_TEXTURES) + 1;
        while (_drawCallPool.length < MAX_SPRITES) {
          _drawCallPool.push(new BatchDrawCall());
        }
        while (_textureArrayPool.length < MAX_TA) {
          _textureArrayPool.push(new BatchTextureArray());
        }
        for (var i = 0; i < this.MAX_TEXTURES; i++) {
          this._tempBoundTextures[i] = null;
        }
      };
      AbstractBatchRenderer2.prototype.onPrerender = function() {
        this._flushId = 0;
      };
      AbstractBatchRenderer2.prototype.render = function(element) {
        if (!element._texture.valid) {
          return;
        }
        if (this._vertexCount + element.vertexData.length / 2 > this.size) {
          this.flush();
        }
        this._vertexCount += element.vertexData.length / 2;
        this._indexCount += element.indices.length;
        this._bufferedTextures[this._bufferSize] = element._texture.baseTexture;
        this._bufferedElements[this._bufferSize++] = element;
      };
      AbstractBatchRenderer2.prototype.buildTexturesAndDrawCalls = function() {
        var _a = this, textures = _a._bufferedTextures, MAX_TEXTURES = _a.MAX_TEXTURES;
        var textureArrays = AbstractBatchRenderer2._textureArrayPool;
        var batch = this.renderer.batch;
        var boundTextures = this._tempBoundTextures;
        var touch = this.renderer.textureGC.count;
        var TICK = ++BaseTexture._globalBatch;
        var countTexArrays = 0;
        var texArray = textureArrays[0];
        var start = 0;
        batch.copyBoundTextures(boundTextures, MAX_TEXTURES);
        for (var i = 0; i < this._bufferSize; ++i) {
          var tex = textures[i];
          textures[i] = null;
          if (tex._batchEnabled === TICK) {
            continue;
          }
          if (texArray.count >= MAX_TEXTURES) {
            batch.boundArray(texArray, boundTextures, TICK, MAX_TEXTURES);
            this.buildDrawCalls(texArray, start, i);
            start = i;
            texArray = textureArrays[++countTexArrays];
            ++TICK;
          }
          tex._batchEnabled = TICK;
          tex.touched = touch;
          texArray.elements[texArray.count++] = tex;
        }
        if (texArray.count > 0) {
          batch.boundArray(texArray, boundTextures, TICK, MAX_TEXTURES);
          this.buildDrawCalls(texArray, start, this._bufferSize);
          ++countTexArrays;
          ++TICK;
        }
        for (var i = 0; i < boundTextures.length; i++) {
          boundTextures[i] = null;
        }
        BaseTexture._globalBatch = TICK;
      };
      AbstractBatchRenderer2.prototype.buildDrawCalls = function(texArray, start, finish) {
        var _a = this, elements = _a._bufferedElements, _attributeBuffer = _a._attributeBuffer, _indexBuffer = _a._indexBuffer, vertexSize = _a.vertexSize;
        var drawCalls = AbstractBatchRenderer2._drawCallPool;
        var dcIndex = this._dcIndex;
        var aIndex = this._aIndex;
        var iIndex = this._iIndex;
        var drawCall = drawCalls[dcIndex];
        drawCall.start = this._iIndex;
        drawCall.texArray = texArray;
        for (var i = start; i < finish; ++i) {
          var sprite = elements[i];
          var tex = sprite._texture.baseTexture;
          var spriteBlendMode = premultiplyBlendMode[tex.alphaMode ? 1 : 0][sprite.blendMode];
          elements[i] = null;
          if (start < i && drawCall.blend !== spriteBlendMode) {
            drawCall.size = iIndex - drawCall.start;
            start = i;
            drawCall = drawCalls[++dcIndex];
            drawCall.texArray = texArray;
            drawCall.start = iIndex;
          }
          this.packInterleavedGeometry(sprite, _attributeBuffer, _indexBuffer, aIndex, iIndex);
          aIndex += sprite.vertexData.length / 2 * vertexSize;
          iIndex += sprite.indices.length;
          drawCall.blend = spriteBlendMode;
        }
        if (start < finish) {
          drawCall.size = iIndex - drawCall.start;
          ++dcIndex;
        }
        this._dcIndex = dcIndex;
        this._aIndex = aIndex;
        this._iIndex = iIndex;
      };
      AbstractBatchRenderer2.prototype.bindAndClearTexArray = function(texArray) {
        var textureSystem = this.renderer.texture;
        for (var j = 0; j < texArray.count; j++) {
          textureSystem.bind(texArray.elements[j], texArray.ids[j]);
          texArray.elements[j] = null;
        }
        texArray.count = 0;
      };
      AbstractBatchRenderer2.prototype.updateGeometry = function() {
        var _a = this, packedGeometries = _a._packedGeometries, attributeBuffer = _a._attributeBuffer, indexBuffer = _a._indexBuffer;
        if (!settings.CAN_UPLOAD_SAME_BUFFER) {
          if (this._packedGeometryPoolSize <= this._flushId) {
            this._packedGeometryPoolSize++;
            packedGeometries[this._flushId] = new this.geometryClass();
          }
          packedGeometries[this._flushId]._buffer.update(attributeBuffer.rawBinaryData);
          packedGeometries[this._flushId]._indexBuffer.update(indexBuffer);
          this.renderer.geometry.bind(packedGeometries[this._flushId]);
          this.renderer.geometry.updateBuffers();
          this._flushId++;
        } else {
          packedGeometries[this._flushId]._buffer.update(attributeBuffer.rawBinaryData);
          packedGeometries[this._flushId]._indexBuffer.update(indexBuffer);
          this.renderer.geometry.updateBuffers();
        }
      };
      AbstractBatchRenderer2.prototype.drawBatches = function() {
        var dcCount = this._dcIndex;
        var _a = this.renderer, gl = _a.gl, stateSystem = _a.state;
        var drawCalls = AbstractBatchRenderer2._drawCallPool;
        var curTexArray = null;
        for (var i = 0; i < dcCount; i++) {
          var _b = drawCalls[i], texArray = _b.texArray, type = _b.type, size = _b.size, start = _b.start, blend = _b.blend;
          if (curTexArray !== texArray) {
            curTexArray = texArray;
            this.bindAndClearTexArray(texArray);
          }
          this.state.blendMode = blend;
          stateSystem.set(this.state);
          gl.drawElements(type, size, gl.UNSIGNED_SHORT, start * 2);
        }
      };
      AbstractBatchRenderer2.prototype.flush = function() {
        if (this._vertexCount === 0) {
          return;
        }
        this._attributeBuffer = this.getAttributeBuffer(this._vertexCount);
        this._indexBuffer = this.getIndexBuffer(this._indexCount);
        this._aIndex = 0;
        this._iIndex = 0;
        this._dcIndex = 0;
        this.buildTexturesAndDrawCalls();
        this.updateGeometry();
        this.drawBatches();
        this._bufferSize = 0;
        this._vertexCount = 0;
        this._indexCount = 0;
      };
      AbstractBatchRenderer2.prototype.start = function() {
        this.renderer.state.set(this.state);
        this.renderer.texture.ensureSamplerType(this.MAX_TEXTURES);
        this.renderer.shader.bind(this._shader);
        if (settings.CAN_UPLOAD_SAME_BUFFER) {
          this.renderer.geometry.bind(this._packedGeometries[this._flushId]);
        }
      };
      AbstractBatchRenderer2.prototype.stop = function() {
        this.flush();
      };
      AbstractBatchRenderer2.prototype.destroy = function() {
        for (var i = 0; i < this._packedGeometryPoolSize; i++) {
          if (this._packedGeometries[i]) {
            this._packedGeometries[i].destroy();
          }
        }
        this.renderer.off("prerender", this.onPrerender, this);
        this._aBuffers = null;
        this._iBuffers = null;
        this._packedGeometries = null;
        this._attributeBuffer = null;
        this._indexBuffer = null;
        if (this._shader) {
          this._shader.destroy();
          this._shader = null;
        }
        _super.prototype.destroy.call(this);
      };
      AbstractBatchRenderer2.prototype.getAttributeBuffer = function(size) {
        var roundedP2 = nextPow2(Math.ceil(size / 8));
        var roundedSizeIndex = log2(roundedP2);
        var roundedSize = roundedP2 * 8;
        if (this._aBuffers.length <= roundedSizeIndex) {
          this._iBuffers.length = roundedSizeIndex + 1;
        }
        var buffer = this._aBuffers[roundedSize];
        if (!buffer) {
          this._aBuffers[roundedSize] = buffer = new ViewableBuffer(roundedSize * this.vertexSize * 4);
        }
        return buffer;
      };
      AbstractBatchRenderer2.prototype.getIndexBuffer = function(size) {
        var roundedP2 = nextPow2(Math.ceil(size / 12));
        var roundedSizeIndex = log2(roundedP2);
        var roundedSize = roundedP2 * 12;
        if (this._iBuffers.length <= roundedSizeIndex) {
          this._iBuffers.length = roundedSizeIndex + 1;
        }
        var buffer = this._iBuffers[roundedSizeIndex];
        if (!buffer) {
          this._iBuffers[roundedSizeIndex] = buffer = new Uint16Array(roundedSize);
        }
        return buffer;
      };
      AbstractBatchRenderer2.prototype.packInterleavedGeometry = function(element, attributeBuffer, indexBuffer, aIndex, iIndex) {
        var uint32View = attributeBuffer.uint32View, float32View = attributeBuffer.float32View;
        var packedVertices = aIndex / this.vertexSize;
        var uvs = element.uvs;
        var indicies = element.indices;
        var vertexData = element.vertexData;
        var textureId = element._texture.baseTexture._batchLocation;
        var alpha = Math.min(element.worldAlpha, 1);
        var argb = alpha < 1 && element._texture.baseTexture.alphaMode ? premultiplyTint(element._tintRGB, alpha) : element._tintRGB + (alpha * 255 << 24);
        for (var i = 0; i < vertexData.length; i += 2) {
          float32View[aIndex++] = vertexData[i];
          float32View[aIndex++] = vertexData[i + 1];
          float32View[aIndex++] = uvs[i];
          float32View[aIndex++] = uvs[i + 1];
          uint32View[aIndex++] = argb;
          float32View[aIndex++] = textureId;
        }
        for (var i = 0; i < indicies.length; i++) {
          indexBuffer[iIndex++] = packedVertices + indicies[i];
        }
      };
      AbstractBatchRenderer2._drawCallPool = [];
      AbstractBatchRenderer2._textureArrayPool = [];
      return AbstractBatchRenderer2;
    })(ObjectRenderer)
  );
  var BatchShaderGenerator = (
    /** @class */
    (function() {
      function BatchShaderGenerator2(vertexSrc, fragTemplate2) {
        this.vertexSrc = vertexSrc;
        this.fragTemplate = fragTemplate2;
        this.programCache = {};
        this.defaultGroupCache = {};
        if (fragTemplate2.indexOf("%count%") < 0) {
          throw new Error('Fragment template must contain "%count%".');
        }
        if (fragTemplate2.indexOf("%forloop%") < 0) {
          throw new Error('Fragment template must contain "%forloop%".');
        }
      }
      BatchShaderGenerator2.prototype.generateShader = function(maxTextures) {
        if (!this.programCache[maxTextures]) {
          var sampleValues = new Int32Array(maxTextures);
          for (var i = 0; i < maxTextures; i++) {
            sampleValues[i] = i;
          }
          this.defaultGroupCache[maxTextures] = UniformGroup.from({ uSamplers: sampleValues }, true);
          var fragmentSrc = this.fragTemplate;
          fragmentSrc = fragmentSrc.replace(/%count%/gi, "" + maxTextures);
          fragmentSrc = fragmentSrc.replace(/%forloop%/gi, this.generateSampleSrc(maxTextures));
          this.programCache[maxTextures] = new Program(this.vertexSrc, fragmentSrc);
        }
        var uniforms = {
          tint: new Float32Array([1, 1, 1, 1]),
          translationMatrix: new Matrix(),
          default: this.defaultGroupCache[maxTextures]
        };
        return new Shader(this.programCache[maxTextures], uniforms);
      };
      BatchShaderGenerator2.prototype.generateSampleSrc = function(maxTextures) {
        var src = "";
        src += "\n";
        src += "\n";
        for (var i = 0; i < maxTextures; i++) {
          if (i > 0) {
            src += "\nelse ";
          }
          if (i < maxTextures - 1) {
            src += "if(vTextureId < " + i + ".5)";
          }
          src += "\n{";
          src += "\n	color = texture2D(uSamplers[" + i + "], vTextureCoord);";
          src += "\n}";
        }
        src += "\n";
        src += "\n";
        return src;
      };
      return BatchShaderGenerator2;
    })()
  );
  var BatchGeometry = (
    /** @class */
    (function(_super) {
      __extends(BatchGeometry2, _super);
      function BatchGeometry2(_static) {
        if (_static === void 0) {
          _static = false;
        }
        var _this = _super.call(this) || this;
        _this._buffer = new Buffer2(null, _static, false);
        _this._indexBuffer = new Buffer2(null, _static, true);
        _this.addAttribute("aVertexPosition", _this._buffer, 2, false, TYPES.FLOAT).addAttribute("aTextureCoord", _this._buffer, 2, false, TYPES.FLOAT).addAttribute("aColor", _this._buffer, 4, true, TYPES.UNSIGNED_BYTE).addAttribute("aTextureId", _this._buffer, 1, true, TYPES.FLOAT).addIndex(_this._indexBuffer);
        return _this;
      }
      return BatchGeometry2;
    })(Geometry)
  );
  var defaultVertex = "precision highp float;\nattribute vec2 aVertexPosition;\nattribute vec2 aTextureCoord;\nattribute vec4 aColor;\nattribute float aTextureId;\n\nuniform mat3 projectionMatrix;\nuniform mat3 translationMatrix;\nuniform vec4 tint;\n\nvarying vec2 vTextureCoord;\nvarying vec4 vColor;\nvarying float vTextureId;\n\nvoid main(void){\n    gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);\n\n    vTextureCoord = aTextureCoord;\n    vTextureId = aTextureId;\n    vColor = aColor * tint;\n}\n";
  var defaultFragment = "varying vec2 vTextureCoord;\nvarying vec4 vColor;\nvarying float vTextureId;\nuniform sampler2D uSamplers[%count%];\n\nvoid main(void){\n    vec4 color;\n    %forloop%\n    gl_FragColor = color * vColor;\n}\n";
  var BatchPluginFactory = (
    /** @class */
    (function() {
      function BatchPluginFactory2() {
      }
      BatchPluginFactory2.create = function(options) {
        var _a = Object.assign({
          vertex: defaultVertex,
          fragment: defaultFragment,
          geometryClass: BatchGeometry,
          vertexSize: 6
        }, options), vertex2 = _a.vertex, fragment2 = _a.fragment, vertexSize = _a.vertexSize, geometryClass = _a.geometryClass;
        return (
          /** @class */
          (function(_super) {
            __extends(BatchPlugin, _super);
            function BatchPlugin(renderer) {
              var _this = _super.call(this, renderer) || this;
              _this.shaderGenerator = new BatchShaderGenerator(vertex2, fragment2);
              _this.geometryClass = geometryClass;
              _this.vertexSize = vertexSize;
              return _this;
            }
            return BatchPlugin;
          })(AbstractBatchRenderer)
        );
      };
      Object.defineProperty(BatchPluginFactory2, "defaultVertexSrc", {
        /**
         * The default vertex shader source
         * @readonly
         */
        get: function() {
          return defaultVertex;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(BatchPluginFactory2, "defaultFragmentTemplate", {
        /**
         * The default fragment shader source
         * @readonly
         */
        get: function() {
          return defaultFragment;
        },
        enumerable: false,
        configurable: true
      });
      return BatchPluginFactory2;
    })()
  );
  var BatchRenderer = BatchPluginFactory.create();
  Object.assign(BatchRenderer, {
    extension: {
      name: "batch",
      type: ExtensionType.RendererPlugin
    }
  });
  var resources = {};
  var _loop_1 = function(name) {
    Object.defineProperty(resources, name, {
      get: function() {
        deprecation("6.0.0", "PIXI.systems." + name + " has moved to PIXI." + name);
        return _resources[name];
      }
    });
  };
  for (name in _resources) {
    _loop_1(name);
  }
  var name;
  var systems = {};
  var _loop_2 = function(name) {
    Object.defineProperty(systems, name, {
      get: function() {
        deprecation("6.0.0", "PIXI.resources." + name + " has moved to PIXI." + name);
        return _systems[name];
      }
    });
  };
  for (name in _systems) {
    _loop_2(name);
  }
  var name;

  // node_modules/@pixi/display/dist/esm/display.mjs
  settings.SORTABLE_CHILDREN = false;
  var Bounds = (
    /** @class */
    (function() {
      function Bounds2() {
        this.minX = Infinity;
        this.minY = Infinity;
        this.maxX = -Infinity;
        this.maxY = -Infinity;
        this.rect = null;
        this.updateID = -1;
      }
      Bounds2.prototype.isEmpty = function() {
        return this.minX > this.maxX || this.minY > this.maxY;
      };
      Bounds2.prototype.clear = function() {
        this.minX = Infinity;
        this.minY = Infinity;
        this.maxX = -Infinity;
        this.maxY = -Infinity;
      };
      Bounds2.prototype.getRectangle = function(rect) {
        if (this.minX > this.maxX || this.minY > this.maxY) {
          return Rectangle.EMPTY;
        }
        rect = rect || new Rectangle(0, 0, 1, 1);
        rect.x = this.minX;
        rect.y = this.minY;
        rect.width = this.maxX - this.minX;
        rect.height = this.maxY - this.minY;
        return rect;
      };
      Bounds2.prototype.addPoint = function(point) {
        this.minX = Math.min(this.minX, point.x);
        this.maxX = Math.max(this.maxX, point.x);
        this.minY = Math.min(this.minY, point.y);
        this.maxY = Math.max(this.maxY, point.y);
      };
      Bounds2.prototype.addPointMatrix = function(matrix, point) {
        var a = matrix.a, b = matrix.b, c = matrix.c, d = matrix.d, tx = matrix.tx, ty = matrix.ty;
        var x = a * point.x + c * point.y + tx;
        var y = b * point.x + d * point.y + ty;
        this.minX = Math.min(this.minX, x);
        this.maxX = Math.max(this.maxX, x);
        this.minY = Math.min(this.minY, y);
        this.maxY = Math.max(this.maxY, y);
      };
      Bounds2.prototype.addQuad = function(vertices) {
        var minX = this.minX;
        var minY = this.minY;
        var maxX = this.maxX;
        var maxY = this.maxY;
        var x = vertices[0];
        var y = vertices[1];
        minX = x < minX ? x : minX;
        minY = y < minY ? y : minY;
        maxX = x > maxX ? x : maxX;
        maxY = y > maxY ? y : maxY;
        x = vertices[2];
        y = vertices[3];
        minX = x < minX ? x : minX;
        minY = y < minY ? y : minY;
        maxX = x > maxX ? x : maxX;
        maxY = y > maxY ? y : maxY;
        x = vertices[4];
        y = vertices[5];
        minX = x < minX ? x : minX;
        minY = y < minY ? y : minY;
        maxX = x > maxX ? x : maxX;
        maxY = y > maxY ? y : maxY;
        x = vertices[6];
        y = vertices[7];
        minX = x < minX ? x : minX;
        minY = y < minY ? y : minY;
        maxX = x > maxX ? x : maxX;
        maxY = y > maxY ? y : maxY;
        this.minX = minX;
        this.minY = minY;
        this.maxX = maxX;
        this.maxY = maxY;
      };
      Bounds2.prototype.addFrame = function(transform, x0, y0, x1, y1) {
        this.addFrameMatrix(transform.worldTransform, x0, y0, x1, y1);
      };
      Bounds2.prototype.addFrameMatrix = function(matrix, x0, y0, x1, y1) {
        var a = matrix.a;
        var b = matrix.b;
        var c = matrix.c;
        var d = matrix.d;
        var tx = matrix.tx;
        var ty = matrix.ty;
        var minX = this.minX;
        var minY = this.minY;
        var maxX = this.maxX;
        var maxY = this.maxY;
        var x = a * x0 + c * y0 + tx;
        var y = b * x0 + d * y0 + ty;
        minX = x < minX ? x : minX;
        minY = y < minY ? y : minY;
        maxX = x > maxX ? x : maxX;
        maxY = y > maxY ? y : maxY;
        x = a * x1 + c * y0 + tx;
        y = b * x1 + d * y0 + ty;
        minX = x < minX ? x : minX;
        minY = y < minY ? y : minY;
        maxX = x > maxX ? x : maxX;
        maxY = y > maxY ? y : maxY;
        x = a * x0 + c * y1 + tx;
        y = b * x0 + d * y1 + ty;
        minX = x < minX ? x : minX;
        minY = y < minY ? y : minY;
        maxX = x > maxX ? x : maxX;
        maxY = y > maxY ? y : maxY;
        x = a * x1 + c * y1 + tx;
        y = b * x1 + d * y1 + ty;
        minX = x < minX ? x : minX;
        minY = y < minY ? y : minY;
        maxX = x > maxX ? x : maxX;
        maxY = y > maxY ? y : maxY;
        this.minX = minX;
        this.minY = minY;
        this.maxX = maxX;
        this.maxY = maxY;
      };
      Bounds2.prototype.addVertexData = function(vertexData, beginOffset, endOffset) {
        var minX = this.minX;
        var minY = this.minY;
        var maxX = this.maxX;
        var maxY = this.maxY;
        for (var i = beginOffset; i < endOffset; i += 2) {
          var x = vertexData[i];
          var y = vertexData[i + 1];
          minX = x < minX ? x : minX;
          minY = y < minY ? y : minY;
          maxX = x > maxX ? x : maxX;
          maxY = y > maxY ? y : maxY;
        }
        this.minX = minX;
        this.minY = minY;
        this.maxX = maxX;
        this.maxY = maxY;
      };
      Bounds2.prototype.addVertices = function(transform, vertices, beginOffset, endOffset) {
        this.addVerticesMatrix(transform.worldTransform, vertices, beginOffset, endOffset);
      };
      Bounds2.prototype.addVerticesMatrix = function(matrix, vertices, beginOffset, endOffset, padX, padY) {
        if (padX === void 0) {
          padX = 0;
        }
        if (padY === void 0) {
          padY = padX;
        }
        var a = matrix.a;
        var b = matrix.b;
        var c = matrix.c;
        var d = matrix.d;
        var tx = matrix.tx;
        var ty = matrix.ty;
        var minX = this.minX;
        var minY = this.minY;
        var maxX = this.maxX;
        var maxY = this.maxY;
        for (var i = beginOffset; i < endOffset; i += 2) {
          var rawX = vertices[i];
          var rawY = vertices[i + 1];
          var x = a * rawX + c * rawY + tx;
          var y = d * rawY + b * rawX + ty;
          minX = Math.min(minX, x - padX);
          maxX = Math.max(maxX, x + padX);
          minY = Math.min(minY, y - padY);
          maxY = Math.max(maxY, y + padY);
        }
        this.minX = minX;
        this.minY = minY;
        this.maxX = maxX;
        this.maxY = maxY;
      };
      Bounds2.prototype.addBounds = function(bounds) {
        var minX = this.minX;
        var minY = this.minY;
        var maxX = this.maxX;
        var maxY = this.maxY;
        this.minX = bounds.minX < minX ? bounds.minX : minX;
        this.minY = bounds.minY < minY ? bounds.minY : minY;
        this.maxX = bounds.maxX > maxX ? bounds.maxX : maxX;
        this.maxY = bounds.maxY > maxY ? bounds.maxY : maxY;
      };
      Bounds2.prototype.addBoundsMask = function(bounds, mask) {
        var _minX = bounds.minX > mask.minX ? bounds.minX : mask.minX;
        var _minY = bounds.minY > mask.minY ? bounds.minY : mask.minY;
        var _maxX = bounds.maxX < mask.maxX ? bounds.maxX : mask.maxX;
        var _maxY = bounds.maxY < mask.maxY ? bounds.maxY : mask.maxY;
        if (_minX <= _maxX && _minY <= _maxY) {
          var minX = this.minX;
          var minY = this.minY;
          var maxX = this.maxX;
          var maxY = this.maxY;
          this.minX = _minX < minX ? _minX : minX;
          this.minY = _minY < minY ? _minY : minY;
          this.maxX = _maxX > maxX ? _maxX : maxX;
          this.maxY = _maxY > maxY ? _maxY : maxY;
        }
      };
      Bounds2.prototype.addBoundsMatrix = function(bounds, matrix) {
        this.addFrameMatrix(matrix, bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
      };
      Bounds2.prototype.addBoundsArea = function(bounds, area) {
        var _minX = bounds.minX > area.x ? bounds.minX : area.x;
        var _minY = bounds.minY > area.y ? bounds.minY : area.y;
        var _maxX = bounds.maxX < area.x + area.width ? bounds.maxX : area.x + area.width;
        var _maxY = bounds.maxY < area.y + area.height ? bounds.maxY : area.y + area.height;
        if (_minX <= _maxX && _minY <= _maxY) {
          var minX = this.minX;
          var minY = this.minY;
          var maxX = this.maxX;
          var maxY = this.maxY;
          this.minX = _minX < minX ? _minX : minX;
          this.minY = _minY < minY ? _minY : minY;
          this.maxX = _maxX > maxX ? _maxX : maxX;
          this.maxY = _maxY > maxY ? _maxY : maxY;
        }
      };
      Bounds2.prototype.pad = function(paddingX, paddingY) {
        if (paddingX === void 0) {
          paddingX = 0;
        }
        if (paddingY === void 0) {
          paddingY = paddingX;
        }
        if (!this.isEmpty()) {
          this.minX -= paddingX;
          this.maxX += paddingX;
          this.minY -= paddingY;
          this.maxY += paddingY;
        }
      };
      Bounds2.prototype.addFramePad = function(x0, y0, x1, y1, padX, padY) {
        x0 -= padX;
        y0 -= padY;
        x1 += padX;
        y1 += padY;
        this.minX = this.minX < x0 ? this.minX : x0;
        this.maxX = this.maxX > x1 ? this.maxX : x1;
        this.minY = this.minY < y0 ? this.minY : y0;
        this.maxY = this.maxY > y1 ? this.maxY : y1;
      };
      return Bounds2;
    })()
  );
  var extendStatics2 = function(d, b) {
    extendStatics2 = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d2, b2) {
      d2.__proto__ = b2;
    } || function(d2, b2) {
      for (var p in b2) {
        if (b2.hasOwnProperty(p)) {
          d2[p] = b2[p];
        }
      }
    };
    return extendStatics2(d, b);
  };
  function __extends2(d, b) {
    extendStatics2(d, b);
    function __() {
      this.constructor = d;
    }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  }
  var DisplayObject = (
    /** @class */
    (function(_super) {
      __extends2(DisplayObject2, _super);
      function DisplayObject2() {
        var _this = _super.call(this) || this;
        _this.tempDisplayObjectParent = null;
        _this.transform = new Transform();
        _this.alpha = 1;
        _this.visible = true;
        _this.renderable = true;
        _this.cullable = false;
        _this.cullArea = null;
        _this.parent = null;
        _this.worldAlpha = 1;
        _this._lastSortedIndex = 0;
        _this._zIndex = 0;
        _this.filterArea = null;
        _this.filters = null;
        _this._enabledFilters = null;
        _this._bounds = new Bounds();
        _this._localBounds = null;
        _this._boundsID = 0;
        _this._boundsRect = null;
        _this._localBoundsRect = null;
        _this._mask = null;
        _this._maskRefCount = 0;
        _this._destroyed = false;
        _this.isSprite = false;
        _this.isMask = false;
        return _this;
      }
      DisplayObject2.mixin = function(source) {
        var keys = Object.keys(source);
        for (var i = 0; i < keys.length; ++i) {
          var propertyName = keys[i];
          Object.defineProperty(DisplayObject2.prototype, propertyName, Object.getOwnPropertyDescriptor(source, propertyName));
        }
      };
      Object.defineProperty(DisplayObject2.prototype, "destroyed", {
        /**
         * Fired when this DisplayObject is added to a Container.
         * @instance
         * @event added
         * @param {PIXI.Container} container - The container added to.
         */
        /**
         * Fired when this DisplayObject is removed from a Container.
         * @instance
         * @event removed
         * @param {PIXI.Container} container - The container removed from.
         */
        /**
         * Fired when this DisplayObject is destroyed. This event is emitted once
         * destroy is finished.
         * @instance
         * @event destroyed
         */
        /** Readonly flag for destroyed display objects. */
        get: function() {
          return this._destroyed;
        },
        enumerable: false,
        configurable: true
      });
      DisplayObject2.prototype._recursivePostUpdateTransform = function() {
        if (this.parent) {
          this.parent._recursivePostUpdateTransform();
          this.transform.updateTransform(this.parent.transform);
        } else {
          this.transform.updateTransform(this._tempDisplayObjectParent.transform);
        }
      };
      DisplayObject2.prototype.updateTransform = function() {
        this._boundsID++;
        this.transform.updateTransform(this.parent.transform);
        this.worldAlpha = this.alpha * this.parent.worldAlpha;
      };
      DisplayObject2.prototype.getBounds = function(skipUpdate, rect) {
        if (!skipUpdate) {
          if (!this.parent) {
            this.parent = this._tempDisplayObjectParent;
            this.updateTransform();
            this.parent = null;
          } else {
            this._recursivePostUpdateTransform();
            this.updateTransform();
          }
        }
        if (this._bounds.updateID !== this._boundsID) {
          this.calculateBounds();
          this._bounds.updateID = this._boundsID;
        }
        if (!rect) {
          if (!this._boundsRect) {
            this._boundsRect = new Rectangle();
          }
          rect = this._boundsRect;
        }
        return this._bounds.getRectangle(rect);
      };
      DisplayObject2.prototype.getLocalBounds = function(rect) {
        if (!rect) {
          if (!this._localBoundsRect) {
            this._localBoundsRect = new Rectangle();
          }
          rect = this._localBoundsRect;
        }
        if (!this._localBounds) {
          this._localBounds = new Bounds();
        }
        var transformRef = this.transform;
        var parentRef = this.parent;
        this.parent = null;
        this.transform = this._tempDisplayObjectParent.transform;
        var worldBounds = this._bounds;
        var worldBoundsID = this._boundsID;
        this._bounds = this._localBounds;
        var bounds = this.getBounds(false, rect);
        this.parent = parentRef;
        this.transform = transformRef;
        this._bounds = worldBounds;
        this._bounds.updateID += this._boundsID - worldBoundsID;
        return bounds;
      };
      DisplayObject2.prototype.toGlobal = function(position, point, skipUpdate) {
        if (skipUpdate === void 0) {
          skipUpdate = false;
        }
        if (!skipUpdate) {
          this._recursivePostUpdateTransform();
          if (!this.parent) {
            this.parent = this._tempDisplayObjectParent;
            this.displayObjectUpdateTransform();
            this.parent = null;
          } else {
            this.displayObjectUpdateTransform();
          }
        }
        return this.worldTransform.apply(position, point);
      };
      DisplayObject2.prototype.toLocal = function(position, from, point, skipUpdate) {
        if (from) {
          position = from.toGlobal(position, point, skipUpdate);
        }
        if (!skipUpdate) {
          this._recursivePostUpdateTransform();
          if (!this.parent) {
            this.parent = this._tempDisplayObjectParent;
            this.displayObjectUpdateTransform();
            this.parent = null;
          } else {
            this.displayObjectUpdateTransform();
          }
        }
        return this.worldTransform.applyInverse(position, point);
      };
      DisplayObject2.prototype.setParent = function(container) {
        if (!container || !container.addChild) {
          throw new Error("setParent: Argument must be a Container");
        }
        container.addChild(this);
        return container;
      };
      DisplayObject2.prototype.setTransform = function(x, y, scaleX, scaleY, rotation, skewX, skewY, pivotX, pivotY) {
        if (x === void 0) {
          x = 0;
        }
        if (y === void 0) {
          y = 0;
        }
        if (scaleX === void 0) {
          scaleX = 1;
        }
        if (scaleY === void 0) {
          scaleY = 1;
        }
        if (rotation === void 0) {
          rotation = 0;
        }
        if (skewX === void 0) {
          skewX = 0;
        }
        if (skewY === void 0) {
          skewY = 0;
        }
        if (pivotX === void 0) {
          pivotX = 0;
        }
        if (pivotY === void 0) {
          pivotY = 0;
        }
        this.position.x = x;
        this.position.y = y;
        this.scale.x = !scaleX ? 1 : scaleX;
        this.scale.y = !scaleY ? 1 : scaleY;
        this.rotation = rotation;
        this.skew.x = skewX;
        this.skew.y = skewY;
        this.pivot.x = pivotX;
        this.pivot.y = pivotY;
        return this;
      };
      DisplayObject2.prototype.destroy = function(_options) {
        if (this.parent) {
          this.parent.removeChild(this);
        }
        this._destroyed = true;
        this.transform = null;
        this.parent = null;
        this._bounds = null;
        this.mask = null;
        this.cullArea = null;
        this.filters = null;
        this.filterArea = null;
        this.hitArea = null;
        this.interactive = false;
        this.interactiveChildren = false;
        this.emit("destroyed");
        this.removeAllListeners();
      };
      Object.defineProperty(DisplayObject2.prototype, "_tempDisplayObjectParent", {
        /**
         * @protected
         * @member {PIXI.Container}
         */
        get: function() {
          if (this.tempDisplayObjectParent === null) {
            this.tempDisplayObjectParent = new TemporaryDisplayObject();
          }
          return this.tempDisplayObjectParent;
        },
        enumerable: false,
        configurable: true
      });
      DisplayObject2.prototype.enableTempParent = function() {
        var myParent = this.parent;
        this.parent = this._tempDisplayObjectParent;
        return myParent;
      };
      DisplayObject2.prototype.disableTempParent = function(cacheParent) {
        this.parent = cacheParent;
      };
      Object.defineProperty(DisplayObject2.prototype, "x", {
        /**
         * The position of the displayObject on the x axis relative to the local coordinates of the parent.
         * An alias to position.x
         */
        get: function() {
          return this.position.x;
        },
        set: function(value) {
          this.transform.position.x = value;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(DisplayObject2.prototype, "y", {
        /**
         * The position of the displayObject on the y axis relative to the local coordinates of the parent.
         * An alias to position.y
         */
        get: function() {
          return this.position.y;
        },
        set: function(value) {
          this.transform.position.y = value;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(DisplayObject2.prototype, "worldTransform", {
        /**
         * Current transform of the object based on world (parent) factors.
         * @readonly
         */
        get: function() {
          return this.transform.worldTransform;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(DisplayObject2.prototype, "localTransform", {
        /**
         * Current transform of the object based on local factors: position, scale, other stuff.
         * @readonly
         */
        get: function() {
          return this.transform.localTransform;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(DisplayObject2.prototype, "position", {
        /**
         * The coordinate of the object relative to the local coordinates of the parent.
         * @since 4.0.0
         */
        get: function() {
          return this.transform.position;
        },
        set: function(value) {
          this.transform.position.copyFrom(value);
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(DisplayObject2.prototype, "scale", {
        /**
         * The scale factors of this object along the local coordinate axes.
         *
         * The default scale is (1, 1).
         * @since 4.0.0
         */
        get: function() {
          return this.transform.scale;
        },
        set: function(value) {
          this.transform.scale.copyFrom(value);
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(DisplayObject2.prototype, "pivot", {
        /**
         * The center of rotation, scaling, and skewing for this display object in its local space. The `position`
         * is the projection of `pivot` in the parent's local space.
         *
         * By default, the pivot is the origin (0, 0).
         * @since 4.0.0
         */
        get: function() {
          return this.transform.pivot;
        },
        set: function(value) {
          this.transform.pivot.copyFrom(value);
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(DisplayObject2.prototype, "skew", {
        /**
         * The skew factor for the object in radians.
         * @since 4.0.0
         */
        get: function() {
          return this.transform.skew;
        },
        set: function(value) {
          this.transform.skew.copyFrom(value);
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(DisplayObject2.prototype, "rotation", {
        /**
         * The rotation of the object in radians.
         * 'rotation' and 'angle' have the same effect on a display object; rotation is in radians, angle is in degrees.
         */
        get: function() {
          return this.transform.rotation;
        },
        set: function(value) {
          this.transform.rotation = value;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(DisplayObject2.prototype, "angle", {
        /**
         * The angle of the object in degrees.
         * 'rotation' and 'angle' have the same effect on a display object; rotation is in radians, angle is in degrees.
         */
        get: function() {
          return this.transform.rotation * RAD_TO_DEG;
        },
        set: function(value) {
          this.transform.rotation = value * DEG_TO_RAD;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(DisplayObject2.prototype, "zIndex", {
        /**
         * The zIndex of the displayObject.
         *
         * If a container has the sortableChildren property set to true, children will be automatically
         * sorted by zIndex value; a higher value will mean it will be moved towards the end of the array,
         * and thus rendered on top of other display objects within the same container.
         * @see PIXI.Container#sortableChildren
         */
        get: function() {
          return this._zIndex;
        },
        set: function(value) {
          this._zIndex = value;
          if (this.parent) {
            this.parent.sortDirty = true;
          }
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(DisplayObject2.prototype, "worldVisible", {
        /**
         * Indicates if the object is globally visible.
         * @readonly
         */
        get: function() {
          var item = this;
          do {
            if (!item.visible) {
              return false;
            }
            item = item.parent;
          } while (item);
          return true;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(DisplayObject2.prototype, "mask", {
        /**
         * Sets a mask for the displayObject. A mask is an object that limits the visibility of an
         * object to the shape of the mask applied to it. In PixiJS a regular mask must be a
         * {@link PIXI.Graphics} or a {@link PIXI.Sprite} object. This allows for much faster masking in canvas as it
         * utilities shape clipping. Furthermore, a mask of an object must be in the subtree of its parent.
         * Otherwise, `getLocalBounds` may calculate incorrect bounds, which makes the container's width and height wrong.
         * To remove a mask, set this property to `null`.
         *
         * For sprite mask both alpha and red channel are used. Black mask is the same as transparent mask.
         * @example
         * const graphics = new PIXI.Graphics();
         * graphics.beginFill(0xFF3300);
         * graphics.drawRect(50, 250, 100, 100);
         * graphics.endFill();
         *
         * const sprite = new PIXI.Sprite(texture);
         * sprite.mask = graphics;
         * @todo At the moment, PIXI.CanvasRenderer doesn't support PIXI.Sprite as mask.
         */
        get: function() {
          return this._mask;
        },
        set: function(value) {
          if (this._mask === value) {
            return;
          }
          if (this._mask) {
            var maskObject = this._mask.isMaskData ? this._mask.maskObject : this._mask;
            if (maskObject) {
              maskObject._maskRefCount--;
              if (maskObject._maskRefCount === 0) {
                maskObject.renderable = true;
                maskObject.isMask = false;
              }
            }
          }
          this._mask = value;
          if (this._mask) {
            var maskObject = this._mask.isMaskData ? this._mask.maskObject : this._mask;
            if (maskObject) {
              if (maskObject._maskRefCount === 0) {
                maskObject.renderable = false;
                maskObject.isMask = true;
              }
              maskObject._maskRefCount++;
            }
          }
        },
        enumerable: false,
        configurable: true
      });
      return DisplayObject2;
    })(import_eventemitter3.default)
  );
  var TemporaryDisplayObject = (
    /** @class */
    (function(_super) {
      __extends2(TemporaryDisplayObject2, _super);
      function TemporaryDisplayObject2() {
        var _this = _super !== null && _super.apply(this, arguments) || this;
        _this.sortDirty = null;
        return _this;
      }
      return TemporaryDisplayObject2;
    })(DisplayObject)
  );
  DisplayObject.prototype.displayObjectUpdateTransform = DisplayObject.prototype.updateTransform;
  function sortChildren(a, b) {
    if (a.zIndex === b.zIndex) {
      return a._lastSortedIndex - b._lastSortedIndex;
    }
    return a.zIndex - b.zIndex;
  }
  var Container = (
    /** @class */
    (function(_super) {
      __extends2(Container2, _super);
      function Container2() {
        var _this = _super.call(this) || this;
        _this.children = [];
        _this.sortableChildren = settings.SORTABLE_CHILDREN;
        _this.sortDirty = false;
        return _this;
      }
      Container2.prototype.onChildrenChange = function(_length) {
      };
      Container2.prototype.addChild = function() {
        var arguments$1 = arguments;
        var children = [];
        for (var _i = 0; _i < arguments.length; _i++) {
          children[_i] = arguments$1[_i];
        }
        if (children.length > 1) {
          for (var i = 0; i < children.length; i++) {
            this.addChild(children[i]);
          }
        } else {
          var child = children[0];
          if (child.parent) {
            child.parent.removeChild(child);
          }
          child.parent = this;
          this.sortDirty = true;
          child.transform._parentID = -1;
          this.children.push(child);
          this._boundsID++;
          this.onChildrenChange(this.children.length - 1);
          this.emit("childAdded", child, this, this.children.length - 1);
          child.emit("added", this);
        }
        return children[0];
      };
      Container2.prototype.addChildAt = function(child, index) {
        if (index < 0 || index > this.children.length) {
          throw new Error(child + "addChildAt: The index " + index + " supplied is out of bounds " + this.children.length);
        }
        if (child.parent) {
          child.parent.removeChild(child);
        }
        child.parent = this;
        this.sortDirty = true;
        child.transform._parentID = -1;
        this.children.splice(index, 0, child);
        this._boundsID++;
        this.onChildrenChange(index);
        child.emit("added", this);
        this.emit("childAdded", child, this, index);
        return child;
      };
      Container2.prototype.swapChildren = function(child, child2) {
        if (child === child2) {
          return;
        }
        var index1 = this.getChildIndex(child);
        var index2 = this.getChildIndex(child2);
        this.children[index1] = child2;
        this.children[index2] = child;
        this.onChildrenChange(index1 < index2 ? index1 : index2);
      };
      Container2.prototype.getChildIndex = function(child) {
        var index = this.children.indexOf(child);
        if (index === -1) {
          throw new Error("The supplied DisplayObject must be a child of the caller");
        }
        return index;
      };
      Container2.prototype.setChildIndex = function(child, index) {
        if (index < 0 || index >= this.children.length) {
          throw new Error("The index " + index + " supplied is out of bounds " + this.children.length);
        }
        var currentIndex = this.getChildIndex(child);
        removeItems(this.children, currentIndex, 1);
        this.children.splice(index, 0, child);
        this.onChildrenChange(index);
      };
      Container2.prototype.getChildAt = function(index) {
        if (index < 0 || index >= this.children.length) {
          throw new Error("getChildAt: Index (" + index + ") does not exist.");
        }
        return this.children[index];
      };
      Container2.prototype.removeChild = function() {
        var arguments$1 = arguments;
        var children = [];
        for (var _i = 0; _i < arguments.length; _i++) {
          children[_i] = arguments$1[_i];
        }
        if (children.length > 1) {
          for (var i = 0; i < children.length; i++) {
            this.removeChild(children[i]);
          }
        } else {
          var child = children[0];
          var index = this.children.indexOf(child);
          if (index === -1) {
            return null;
          }
          child.parent = null;
          child.transform._parentID = -1;
          removeItems(this.children, index, 1);
          this._boundsID++;
          this.onChildrenChange(index);
          child.emit("removed", this);
          this.emit("childRemoved", child, this, index);
        }
        return children[0];
      };
      Container2.prototype.removeChildAt = function(index) {
        var child = this.getChildAt(index);
        child.parent = null;
        child.transform._parentID = -1;
        removeItems(this.children, index, 1);
        this._boundsID++;
        this.onChildrenChange(index);
        child.emit("removed", this);
        this.emit("childRemoved", child, this, index);
        return child;
      };
      Container2.prototype.removeChildren = function(beginIndex, endIndex) {
        if (beginIndex === void 0) {
          beginIndex = 0;
        }
        if (endIndex === void 0) {
          endIndex = this.children.length;
        }
        var begin = beginIndex;
        var end = endIndex;
        var range = end - begin;
        var removed;
        if (range > 0 && range <= end) {
          removed = this.children.splice(begin, range);
          for (var i = 0; i < removed.length; ++i) {
            removed[i].parent = null;
            if (removed[i].transform) {
              removed[i].transform._parentID = -1;
            }
          }
          this._boundsID++;
          this.onChildrenChange(beginIndex);
          for (var i = 0; i < removed.length; ++i) {
            removed[i].emit("removed", this);
            this.emit("childRemoved", removed[i], this, i);
          }
          return removed;
        } else if (range === 0 && this.children.length === 0) {
          return [];
        }
        throw new RangeError("removeChildren: numeric values are outside the acceptable range.");
      };
      Container2.prototype.sortChildren = function() {
        var sortRequired = false;
        for (var i = 0, j = this.children.length; i < j; ++i) {
          var child = this.children[i];
          child._lastSortedIndex = i;
          if (!sortRequired && child.zIndex !== 0) {
            sortRequired = true;
          }
        }
        if (sortRequired && this.children.length > 1) {
          this.children.sort(sortChildren);
        }
        this.sortDirty = false;
      };
      Container2.prototype.updateTransform = function() {
        if (this.sortableChildren && this.sortDirty) {
          this.sortChildren();
        }
        this._boundsID++;
        this.transform.updateTransform(this.parent.transform);
        this.worldAlpha = this.alpha * this.parent.worldAlpha;
        for (var i = 0, j = this.children.length; i < j; ++i) {
          var child = this.children[i];
          if (child.visible) {
            child.updateTransform();
          }
        }
      };
      Container2.prototype.calculateBounds = function() {
        this._bounds.clear();
        this._calculateBounds();
        for (var i = 0; i < this.children.length; i++) {
          var child = this.children[i];
          if (!child.visible || !child.renderable) {
            continue;
          }
          child.calculateBounds();
          if (child._mask) {
            var maskObject = child._mask.isMaskData ? child._mask.maskObject : child._mask;
            if (maskObject) {
              maskObject.calculateBounds();
              this._bounds.addBoundsMask(child._bounds, maskObject._bounds);
            } else {
              this._bounds.addBounds(child._bounds);
            }
          } else if (child.filterArea) {
            this._bounds.addBoundsArea(child._bounds, child.filterArea);
          } else {
            this._bounds.addBounds(child._bounds);
          }
        }
        this._bounds.updateID = this._boundsID;
      };
      Container2.prototype.getLocalBounds = function(rect, skipChildrenUpdate) {
        if (skipChildrenUpdate === void 0) {
          skipChildrenUpdate = false;
        }
        var result = _super.prototype.getLocalBounds.call(this, rect);
        if (!skipChildrenUpdate) {
          for (var i = 0, j = this.children.length; i < j; ++i) {
            var child = this.children[i];
            if (child.visible) {
              child.updateTransform();
            }
          }
        }
        return result;
      };
      Container2.prototype._calculateBounds = function() {
      };
      Container2.prototype._renderWithCulling = function(renderer) {
        var sourceFrame = renderer.renderTexture.sourceFrame;
        if (!(sourceFrame.width > 0 && sourceFrame.height > 0)) {
          return;
        }
        var bounds;
        var transform;
        if (this.cullArea) {
          bounds = this.cullArea;
          transform = this.worldTransform;
        } else if (this._render !== Container2.prototype._render) {
          bounds = this.getBounds(true);
        }
        if (bounds && sourceFrame.intersects(bounds, transform)) {
          this._render(renderer);
        } else if (this.cullArea) {
          return;
        }
        for (var i = 0, j = this.children.length; i < j; ++i) {
          var child = this.children[i];
          var childCullable = child.cullable;
          child.cullable = childCullable || !this.cullArea;
          child.render(renderer);
          child.cullable = childCullable;
        }
      };
      Container2.prototype.render = function(renderer) {
        if (!this.visible || this.worldAlpha <= 0 || !this.renderable) {
          return;
        }
        if (this._mask || this.filters && this.filters.length) {
          this.renderAdvanced(renderer);
        } else if (this.cullable) {
          this._renderWithCulling(renderer);
        } else {
          this._render(renderer);
          for (var i = 0, j = this.children.length; i < j; ++i) {
            this.children[i].render(renderer);
          }
        }
      };
      Container2.prototype.renderAdvanced = function(renderer) {
        var filters = this.filters;
        var mask = this._mask;
        if (filters) {
          if (!this._enabledFilters) {
            this._enabledFilters = [];
          }
          this._enabledFilters.length = 0;
          for (var i = 0; i < filters.length; i++) {
            if (filters[i].enabled) {
              this._enabledFilters.push(filters[i]);
            }
          }
        }
        var flush = filters && this._enabledFilters && this._enabledFilters.length || mask && (!mask.isMaskData || mask.enabled && (mask.autoDetect || mask.type !== MASK_TYPES.NONE));
        if (flush) {
          renderer.batch.flush();
        }
        if (filters && this._enabledFilters && this._enabledFilters.length) {
          renderer.filter.push(this, this._enabledFilters);
        }
        if (mask) {
          renderer.mask.push(this, this._mask);
        }
        if (this.cullable) {
          this._renderWithCulling(renderer);
        } else {
          this._render(renderer);
          for (var i = 0, j = this.children.length; i < j; ++i) {
            this.children[i].render(renderer);
          }
        }
        if (flush) {
          renderer.batch.flush();
        }
        if (mask) {
          renderer.mask.pop(this);
        }
        if (filters && this._enabledFilters && this._enabledFilters.length) {
          renderer.filter.pop();
        }
      };
      Container2.prototype._render = function(_renderer) {
      };
      Container2.prototype.destroy = function(options) {
        _super.prototype.destroy.call(this);
        this.sortDirty = false;
        var destroyChildren = typeof options === "boolean" ? options : options && options.children;
        var oldChildren = this.removeChildren(0, this.children.length);
        if (destroyChildren) {
          for (var i = 0; i < oldChildren.length; ++i) {
            oldChildren[i].destroy(options);
          }
        }
      };
      Object.defineProperty(Container2.prototype, "width", {
        /** The width of the Container, setting this will actually modify the scale to achieve the value set. */
        get: function() {
          return this.scale.x * this.getLocalBounds().width;
        },
        set: function(value) {
          var width = this.getLocalBounds().width;
          if (width !== 0) {
            this.scale.x = value / width;
          } else {
            this.scale.x = 1;
          }
          this._width = value;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(Container2.prototype, "height", {
        /** The height of the Container, setting this will actually modify the scale to achieve the value set. */
        get: function() {
          return this.scale.y * this.getLocalBounds().height;
        },
        set: function(value) {
          var height = this.getLocalBounds().height;
          if (height !== 0) {
            this.scale.y = value / height;
          } else {
            this.scale.y = 1;
          }
          this._height = value;
        },
        enumerable: false,
        configurable: true
      });
      return Container2;
    })(DisplayObject)
  );
  Container.prototype.containerUpdateTransform = Container.prototype.updateTransform;

  // node_modules/@pixi/app/dist/esm/app.mjs
  var ResizePlugin = (
    /** @class */
    (function() {
      function ResizePlugin2() {
      }
      ResizePlugin2.init = function(options) {
        var _this = this;
        Object.defineProperty(
          this,
          "resizeTo",
          /**
           * The HTML element or window to automatically resize the
           * renderer's view element to match width and height.
           * @member {Window|HTMLElement}
           * @name resizeTo
           * @memberof PIXI.Application#
           */
          {
            set: function(dom) {
              globalThis.removeEventListener("resize", this.queueResize);
              this._resizeTo = dom;
              if (dom) {
                globalThis.addEventListener("resize", this.queueResize);
                this.resize();
              }
            },
            get: function() {
              return this._resizeTo;
            }
          }
        );
        this.queueResize = function() {
          if (!_this._resizeTo) {
            return;
          }
          _this.cancelResize();
          _this._resizeId = requestAnimationFrame(function() {
            return _this.resize();
          });
        };
        this.cancelResize = function() {
          if (_this._resizeId) {
            cancelAnimationFrame(_this._resizeId);
            _this._resizeId = null;
          }
        };
        this.resize = function() {
          if (!_this._resizeTo) {
            return;
          }
          _this.cancelResize();
          var width;
          var height;
          if (_this._resizeTo === globalThis.window) {
            width = globalThis.innerWidth;
            height = globalThis.innerHeight;
          } else {
            var _a = _this._resizeTo, clientWidth = _a.clientWidth, clientHeight = _a.clientHeight;
            width = clientWidth;
            height = clientHeight;
          }
          _this.renderer.resize(width, height);
        };
        this._resizeId = null;
        this._resizeTo = null;
        this.resizeTo = options.resizeTo || null;
      };
      ResizePlugin2.destroy = function() {
        globalThis.removeEventListener("resize", this.queueResize);
        this.cancelResize();
        this.cancelResize = null;
        this.queueResize = null;
        this.resizeTo = null;
        this.resize = null;
      };
      ResizePlugin2.extension = ExtensionType.Application;
      return ResizePlugin2;
    })()
  );
  var Application = (
    /** @class */
    (function() {
      function Application2(options) {
        var _this = this;
        this.stage = new Container();
        options = Object.assign({
          forceCanvas: false
        }, options);
        this.renderer = autoDetectRenderer(options);
        Application2._plugins.forEach(function(plugin) {
          plugin.init.call(_this, options);
        });
      }
      Application2.registerPlugin = function(plugin) {
        deprecation("6.5.0", "Application.registerPlugin() is deprecated, use extensions.add()");
        extensions.add({
          type: ExtensionType.Application,
          ref: plugin
        });
      };
      Application2.prototype.render = function() {
        this.renderer.render(this.stage);
      };
      Object.defineProperty(Application2.prototype, "view", {
        /**
         * Reference to the renderer's canvas element.
         * @member {HTMLCanvasElement}
         * @readonly
         */
        get: function() {
          return this.renderer.view;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(Application2.prototype, "screen", {
        /**
         * Reference to the renderer's screen rectangle. Its safe to use as `filterArea` or `hitArea` for the whole screen.
         * @member {PIXI.Rectangle}
         * @readonly
         */
        get: function() {
          return this.renderer.screen;
        },
        enumerable: false,
        configurable: true
      });
      Application2.prototype.destroy = function(removeView, stageOptions) {
        var _this = this;
        var plugins = Application2._plugins.slice(0);
        plugins.reverse();
        plugins.forEach(function(plugin) {
          plugin.destroy.call(_this);
        });
        this.stage.destroy(stageOptions);
        this.stage = null;
        this.renderer.destroy(removeView);
        this.renderer = null;
      };
      Application2._plugins = [];
      return Application2;
    })()
  );
  extensions.handleByList(ExtensionType.Application, Application._plugins);
  extensions.add(ResizePlugin);

  // src/pixi-stage.ts
  var PixiStage = class {
    constructor(parent, error, preserveDrawingBuffer = true) {
      this.error = error;
      this.preserveDrawingBuffer = preserveDrawingBuffer;
      this.app = new Application({ width: parent.clientWidth, height: parent.clientHeight, backgroundAlpha: 0, resolution: 1, autoDensity: true, antialias: true, preserveDrawingBuffer: this.preserveDrawingBuffer });
      parent.appendChild(this.app.view);
      this.app.view.style.width = "100%";
      this.app.view.style.height = "100%";
      this.observer = new ResizeObserver(() => {
        this.app.renderer.resize(parent.clientWidth, parent.clientHeight);
        this.resized();
      });
      this.observer.observe(parent);
      this.resume();
    }
    app;
    observer;
    timer;
    last = 0;
    frames = 0;
    epoch = performance.now();
    measuredFPS = null;
    fps = 30;
    paused = false;
    update = () => {
    };
    resized = () => {
    };
    get activeRAFCount() {
      return this.timer === void 0 ? 0 : 1;
    }
    tick = () => {
      const now = performance.now();
      if (now - this.last >= 1e3 / this.fps - 1) {
        const dt = this.last ? Math.min((now - this.last) / 1e3, 0.1) : 0;
        this.last = now;
        try {
          this.update(dt);
          this.app.render();
          this.frames++;
          if (now - this.epoch >= 1e3) {
            this.measuredFPS = this.frames * 1e3 / (now - this.epoch);
            this.frames = 0;
            this.epoch = now;
          }
        } catch (e) {
          this.pause();
          this.error(e);
          return;
        }
      }
      this.timer = requestAnimationFrame(this.tick);
    };
    pause() {
      this.paused = true;
      if (this.timer !== void 0) cancelAnimationFrame(this.timer);
      this.timer = void 0;
    }
    resume() {
      if (this.timer !== void 0) return;
      this.paused = false;
      this.last = 0;
      this.timer = requestAnimationFrame(this.tick);
    }
    destroy() {
      this.pause();
      this.observer.disconnect();
      this.app.destroy(true, { children: true, texture: true, baseTexture: true });
    }
  };

  // node_modules/pixi-live2d-display/dist/cubism4.es.js
  var __pow = Math.pow;
  var __async = (__this, __arguments, generator) => {
    return new Promise((resolve2, reject) => {
      var fulfilled = (value) => {
        try {
          step(generator.next(value));
        } catch (e) {
          reject(e);
        }
      };
      var rejected = (value) => {
        try {
          step(generator.throw(value));
        } catch (e) {
          reject(e);
        }
      };
      var step = (x) => x.done ? resolve2(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
      step((generator = generator.apply(__this, __arguments)).next());
    });
  };
  var CubismBreath = class _CubismBreath {
    constructor() {
      this._breathParameters = [];
      this._currentTime = 0;
    }
    static create() {
      return new _CubismBreath();
    }
    setParameters(breathParameters) {
      this._breathParameters = breathParameters;
    }
    getParameters() {
      return this._breathParameters;
    }
    updateParameters(model, deltaTimeSeconds) {
      this._currentTime += deltaTimeSeconds;
      const t = this._currentTime * 2 * 3.14159;
      for (let i = 0; i < this._breathParameters.length; ++i) {
        const data = this._breathParameters[i];
        model.addParameterValueById(data.parameterId, data.offset + data.peak * Math.sin(t / data.cycle), data.weight);
      }
    }
  };
  var BreathParameterData = class {
    constructor(parameterId, offset, peak, cycle, weight) {
      this.parameterId = parameterId == void 0 ? void 0 : parameterId;
      this.offset = offset == void 0 ? 0 : offset;
      this.peak = peak == void 0 ? 0 : peak;
      this.cycle = cycle == void 0 ? 0 : cycle;
      this.weight = weight == void 0 ? 0 : weight;
    }
  };
  var _CubismEyeBlink = class {
    static create(modelSetting) {
      return new _CubismEyeBlink(modelSetting);
    }
    setBlinkingInterval(blinkingInterval) {
      this._blinkingIntervalSeconds = blinkingInterval;
    }
    setBlinkingSetting(closing, closed, opening) {
      this._closingSeconds = closing;
      this._closedSeconds = closed;
      this._openingSeconds = opening;
    }
    setParameterIds(parameterIds) {
      this._parameterIds = parameterIds;
    }
    getParameterIds() {
      return this._parameterIds;
    }
    updateParameters(model, deltaTimeSeconds) {
      this._userTimeSeconds += deltaTimeSeconds;
      let parameterValue;
      let t = 0;
      switch (this._blinkingState) {
        case EyeState.EyeState_Closing:
          t = (this._userTimeSeconds - this._stateStartTimeSeconds) / this._closingSeconds;
          if (t >= 1) {
            t = 1;
            this._blinkingState = EyeState.EyeState_Closed;
            this._stateStartTimeSeconds = this._userTimeSeconds;
          }
          parameterValue = 1 - t;
          break;
        case EyeState.EyeState_Closed:
          t = (this._userTimeSeconds - this._stateStartTimeSeconds) / this._closedSeconds;
          if (t >= 1) {
            this._blinkingState = EyeState.EyeState_Opening;
            this._stateStartTimeSeconds = this._userTimeSeconds;
          }
          parameterValue = 0;
          break;
        case EyeState.EyeState_Opening:
          t = (this._userTimeSeconds - this._stateStartTimeSeconds) / this._openingSeconds;
          if (t >= 1) {
            t = 1;
            this._blinkingState = EyeState.EyeState_Interval;
            this._nextBlinkingTime = this.determinNextBlinkingTiming();
          }
          parameterValue = t;
          break;
        case EyeState.EyeState_Interval:
          if (this._nextBlinkingTime < this._userTimeSeconds) {
            this._blinkingState = EyeState.EyeState_Closing;
            this._stateStartTimeSeconds = this._userTimeSeconds;
          }
          parameterValue = 1;
          break;
        case EyeState.EyeState_First:
        default:
          this._blinkingState = EyeState.EyeState_Interval;
          this._nextBlinkingTime = this.determinNextBlinkingTiming();
          parameterValue = 1;
          break;
      }
      if (!_CubismEyeBlink.CloseIfZero) {
        parameterValue = -parameterValue;
      }
      for (let i = 0; i < this._parameterIds.length; ++i) {
        model.setParameterValueById(this._parameterIds[i], parameterValue);
      }
    }
    constructor(modelSetting) {
      var _a, _b;
      this._blinkingState = EyeState.EyeState_First;
      this._nextBlinkingTime = 0;
      this._stateStartTimeSeconds = 0;
      this._blinkingIntervalSeconds = 4;
      this._closingSeconds = 0.1;
      this._closedSeconds = 0.05;
      this._openingSeconds = 0.15;
      this._userTimeSeconds = 0;
      this._parameterIds = [];
      if (modelSetting == null) {
        return;
      }
      this._parameterIds = (_b = (_a = modelSetting.getEyeBlinkParameters()) == null ? void 0 : _a.slice()) != null ? _b : this._parameterIds;
    }
    determinNextBlinkingTiming() {
      const r = Math.random();
      return this._userTimeSeconds + r * (2 * this._blinkingIntervalSeconds - 1);
    }
  };
  var CubismEyeBlink = _CubismEyeBlink;
  CubismEyeBlink.CloseIfZero = true;
  var EyeState = /* @__PURE__ */ ((EyeState2) => {
    EyeState2[EyeState2["EyeState_First"] = 0] = "EyeState_First";
    EyeState2[EyeState2["EyeState_Interval"] = 1] = "EyeState_Interval";
    EyeState2[EyeState2["EyeState_Closing"] = 2] = "EyeState_Closing";
    EyeState2[EyeState2["EyeState_Closed"] = 3] = "EyeState_Closed";
    EyeState2[EyeState2["EyeState_Opening"] = 4] = "EyeState_Opening";
    return EyeState2;
  })(EyeState || {});
  var Epsilon = 1e-3;
  var DefaultFadeInSeconds = 0.5;
  var CubismPose = class _CubismPose {
    static create(pose3json) {
      const ret = new _CubismPose();
      if (typeof pose3json.FadeInTime === "number") {
        ret._fadeTimeSeconds = pose3json.FadeInTime;
        if (ret._fadeTimeSeconds <= 0) {
          ret._fadeTimeSeconds = DefaultFadeInSeconds;
        }
      }
      const poseListInfo = pose3json.Groups;
      const poseCount = poseListInfo.length;
      for (let poseIndex = 0; poseIndex < poseCount; ++poseIndex) {
        const idListInfo = poseListInfo[poseIndex];
        const idCount = idListInfo.length;
        let groupCount = 0;
        for (let groupIndex = 0; groupIndex < idCount; ++groupIndex) {
          const partInfo = idListInfo[groupIndex];
          const partData = new PartData();
          partData.partId = partInfo.Id;
          const linkListInfo = partInfo.Link;
          if (linkListInfo) {
            const linkCount = linkListInfo.length;
            for (let linkIndex = 0; linkIndex < linkCount; ++linkIndex) {
              const linkPart = new PartData();
              linkPart.partId = linkListInfo[linkIndex];
              partData.link.push(linkPart);
            }
          }
          ret._partGroups.push(partData);
          ++groupCount;
        }
        ret._partGroupCounts.push(groupCount);
      }
      return ret;
    }
    updateParameters(model, deltaTimeSeconds) {
      if (model != this._lastModel) {
        this.reset(model);
      }
      this._lastModel = model;
      if (deltaTimeSeconds < 0) {
        deltaTimeSeconds = 0;
      }
      let beginIndex = 0;
      for (let i = 0; i < this._partGroupCounts.length; i++) {
        const partGroupCount = this._partGroupCounts[i];
        this.doFade(model, deltaTimeSeconds, beginIndex, partGroupCount);
        beginIndex += partGroupCount;
      }
      this.copyPartOpacities(model);
    }
    reset(model) {
      let beginIndex = 0;
      for (let i = 0; i < this._partGroupCounts.length; ++i) {
        const groupCount = this._partGroupCounts[i];
        for (let j = beginIndex; j < beginIndex + groupCount; ++j) {
          this._partGroups[j].initialize(model);
          const partsIndex = this._partGroups[j].partIndex;
          const paramIndex = this._partGroups[j].parameterIndex;
          if (partsIndex < 0) {
            continue;
          }
          model.setPartOpacityByIndex(partsIndex, j == beginIndex ? 1 : 0);
          model.setParameterValueByIndex(paramIndex, j == beginIndex ? 1 : 0);
          for (let k = 0; k < this._partGroups[j].link.length; ++k) {
            this._partGroups[j].link[k].initialize(model);
          }
        }
        beginIndex += groupCount;
      }
    }
    copyPartOpacities(model) {
      for (let groupIndex = 0; groupIndex < this._partGroups.length; ++groupIndex) {
        const partData = this._partGroups[groupIndex];
        if (partData.link.length == 0) {
          continue;
        }
        const partIndex = this._partGroups[groupIndex].partIndex;
        const opacity = model.getPartOpacityByIndex(partIndex);
        for (let linkIndex = 0; linkIndex < partData.link.length; ++linkIndex) {
          const linkPart = partData.link[linkIndex];
          const linkPartIndex = linkPart.partIndex;
          if (linkPartIndex < 0) {
            continue;
          }
          model.setPartOpacityByIndex(linkPartIndex, opacity);
        }
      }
    }
    doFade(model, deltaTimeSeconds, beginIndex, partGroupCount) {
      let visiblePartIndex = -1;
      let newOpacity = 1;
      const phi = 0.5;
      const backOpacityThreshold = 0.15;
      for (let i = beginIndex; i < beginIndex + partGroupCount; ++i) {
        const partIndex = this._partGroups[i].partIndex;
        const paramIndex = this._partGroups[i].parameterIndex;
        if (model.getParameterValueByIndex(paramIndex) > Epsilon) {
          if (visiblePartIndex >= 0) {
            break;
          }
          visiblePartIndex = i;
          newOpacity = model.getPartOpacityByIndex(partIndex);
          newOpacity += deltaTimeSeconds / this._fadeTimeSeconds;
          if (newOpacity > 1) {
            newOpacity = 1;
          }
        }
      }
      if (visiblePartIndex < 0) {
        visiblePartIndex = 0;
        newOpacity = 1;
      }
      for (let i = beginIndex; i < beginIndex + partGroupCount; ++i) {
        const partsIndex = this._partGroups[i].partIndex;
        if (visiblePartIndex == i) {
          model.setPartOpacityByIndex(partsIndex, newOpacity);
        } else {
          let opacity = model.getPartOpacityByIndex(partsIndex);
          let a1;
          if (newOpacity < phi) {
            a1 = newOpacity * (phi - 1) / phi + 1;
          } else {
            a1 = (1 - newOpacity) * phi / (1 - phi);
          }
          const backOpacity = (1 - a1) * (1 - newOpacity);
          if (backOpacity > backOpacityThreshold) {
            a1 = 1 - backOpacityThreshold / (1 - newOpacity);
          }
          if (opacity > a1) {
            opacity = a1;
          }
          model.setPartOpacityByIndex(partsIndex, opacity);
        }
      }
    }
    constructor() {
      this._fadeTimeSeconds = DefaultFadeInSeconds;
      this._lastModel = void 0;
      this._partGroups = [];
      this._partGroupCounts = [];
    }
  };
  var PartData = class _PartData {
    constructor(v) {
      this.parameterIndex = 0;
      this.partIndex = 0;
      this.partId = "";
      this.link = [];
      if (v != void 0) {
        this.assignment(v);
      }
    }
    assignment(v) {
      this.partId = v.partId;
      this.link = v.link.map((link) => link.clone());
      return this;
    }
    initialize(model) {
      this.parameterIndex = model.getParameterIndex(this.partId);
      this.partIndex = model.getPartIndex(this.partId);
      model.setParameterValueByIndex(this.parameterIndex, 1);
    }
    clone() {
      const clonePartData = new _PartData();
      clonePartData.partId = this.partId;
      clonePartData.parameterIndex = this.parameterIndex;
      clonePartData.partIndex = this.partIndex;
      clonePartData.link = this.link.map((link) => link.clone());
      return clonePartData;
    }
  };
  var CubismVector2 = class _CubismVector2 {
    constructor(x, y) {
      this.x = x || 0;
      this.y = y || 0;
    }
    add(vector2) {
      const ret = new _CubismVector2(0, 0);
      ret.x = this.x + vector2.x;
      ret.y = this.y + vector2.y;
      return ret;
    }
    substract(vector2) {
      const ret = new _CubismVector2(0, 0);
      ret.x = this.x - vector2.x;
      ret.y = this.y - vector2.y;
      return ret;
    }
    multiply(vector2) {
      const ret = new _CubismVector2(0, 0);
      ret.x = this.x * vector2.x;
      ret.y = this.y * vector2.y;
      return ret;
    }
    multiplyByScaler(scalar) {
      return this.multiply(new _CubismVector2(scalar, scalar));
    }
    division(vector2) {
      const ret = new _CubismVector2(0, 0);
      ret.x = this.x / vector2.x;
      ret.y = this.y / vector2.y;
      return ret;
    }
    divisionByScalar(scalar) {
      return this.division(new _CubismVector2(scalar, scalar));
    }
    getLength() {
      return Math.sqrt(this.x * this.x + this.y * this.y);
    }
    getDistanceWith(a) {
      return Math.sqrt((this.x - a.x) * (this.x - a.x) + (this.y - a.y) * (this.y - a.y));
    }
    dot(a) {
      return this.x * a.x + this.y * a.y;
    }
    normalize() {
      const length = Math.pow(this.x * this.x + this.y * this.y, 0.5);
      this.x = this.x / length;
      this.y = this.y / length;
    }
    isEqual(rhs) {
      return this.x == rhs.x && this.y == rhs.y;
    }
    isNotEqual(rhs) {
      return !this.isEqual(rhs);
    }
  };
  var _CubismMath = class {
    static range(value, min, max) {
      if (value < min) {
        value = min;
      } else if (value > max) {
        value = max;
      }
      return value;
    }
    static sin(x) {
      return Math.sin(x);
    }
    static cos(x) {
      return Math.cos(x);
    }
    static abs(x) {
      return Math.abs(x);
    }
    static sqrt(x) {
      return Math.sqrt(x);
    }
    static cbrt(x) {
      if (x === 0) {
        return x;
      }
      let cx = x;
      const isNegativeNumber = cx < 0;
      if (isNegativeNumber) {
        cx = -cx;
      }
      let ret;
      if (cx === Infinity) {
        ret = Infinity;
      } else {
        ret = Math.exp(Math.log(cx) / 3);
        ret = (cx / (ret * ret) + 2 * ret) / 3;
      }
      return isNegativeNumber ? -ret : ret;
    }
    static getEasingSine(value) {
      if (value < 0) {
        return 0;
      } else if (value > 1) {
        return 1;
      }
      return 0.5 - 0.5 * this.cos(value * Math.PI);
    }
    static max(left, right) {
      return left > right ? left : right;
    }
    static min(left, right) {
      return left > right ? right : left;
    }
    static degreesToRadian(degrees) {
      return degrees / 180 * Math.PI;
    }
    static radianToDegrees(radian) {
      return radian * 180 / Math.PI;
    }
    static directionToRadian(from, to) {
      const q1 = Math.atan2(to.y, to.x);
      const q2 = Math.atan2(from.y, from.x);
      let ret = q1 - q2;
      while (ret < -Math.PI) {
        ret += Math.PI * 2;
      }
      while (ret > Math.PI) {
        ret -= Math.PI * 2;
      }
      return ret;
    }
    static directionToDegrees(from, to) {
      const radian = this.directionToRadian(from, to);
      let degree = this.radianToDegrees(radian);
      if (to.x - from.x > 0) {
        degree = -degree;
      }
      return degree;
    }
    static radianToDirection(totalAngle) {
      const ret = new CubismVector2();
      ret.x = this.sin(totalAngle);
      ret.y = this.cos(totalAngle);
      return ret;
    }
    static quadraticEquation(a, b, c) {
      if (this.abs(a) < _CubismMath.Epsilon) {
        if (this.abs(b) < _CubismMath.Epsilon) {
          return -c;
        }
        return -c / b;
      }
      return -(b + this.sqrt(b * b - 4 * a * c)) / (2 * a);
    }
    static cardanoAlgorithmForBezier(a, b, c, d) {
      if (this.sqrt(a) < _CubismMath.Epsilon) {
        return this.range(this.quadraticEquation(b, c, d), 0, 1);
      }
      const ba = b / a;
      const ca = c / a;
      const da = d / a;
      const p = (3 * ca - ba * ba) / 3;
      const p3 = p / 3;
      const q = (2 * ba * ba * ba - 9 * ba * ca + 27 * da) / 27;
      const q2 = q / 2;
      const discriminant = q2 * q2 + p3 * p3 * p3;
      const center = 0.5;
      const threshold = center + 0.01;
      if (discriminant < 0) {
        const mp3 = -p / 3;
        const mp33 = mp3 * mp3 * mp3;
        const r = this.sqrt(mp33);
        const t = -q / (2 * r);
        const cosphi = this.range(t, -1, 1);
        const phi = Math.acos(cosphi);
        const crtr = this.cbrt(r);
        const t1 = 2 * crtr;
        const root12 = t1 * this.cos(phi / 3) - ba / 3;
        if (this.abs(root12 - center) < threshold) {
          return this.range(root12, 0, 1);
        }
        const root2 = t1 * this.cos((phi + 2 * Math.PI) / 3) - ba / 3;
        if (this.abs(root2 - center) < threshold) {
          return this.range(root2, 0, 1);
        }
        const root3 = t1 * this.cos((phi + 4 * Math.PI) / 3) - ba / 3;
        return this.range(root3, 0, 1);
      }
      if (discriminant == 0) {
        let u12;
        if (q2 < 0) {
          u12 = this.cbrt(-q2);
        } else {
          u12 = -this.cbrt(q2);
        }
        const root12 = 2 * u12 - ba / 3;
        if (this.abs(root12 - center) < threshold) {
          return this.range(root12, 0, 1);
        }
        const root2 = -u12 - ba / 3;
        return this.range(root2, 0, 1);
      }
      const sd = this.sqrt(discriminant);
      const u1 = this.cbrt(sd - q2);
      const v1 = this.cbrt(sd + q2);
      const root1 = u1 - v1 - ba / 3;
      return this.range(root1, 0, 1);
    }
    constructor() {
    }
  };
  var CubismMath = _CubismMath;
  CubismMath.Epsilon = 1e-5;
  var CubismMatrix44 = class _CubismMatrix44 {
    constructor() {
      this._tr = new Float32Array(16);
      this.loadIdentity();
    }
    static multiply(a, b, dst) {
      const c = new Float32Array([
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0
      ]);
      const n = 4;
      for (let i = 0; i < n; ++i) {
        for (let j = 0; j < n; ++j) {
          for (let k = 0; k < n; ++k) {
            c[j + i * 4] += a[k + i * 4] * b[j + k * 4];
          }
        }
      }
      for (let i = 0; i < 16; ++i) {
        dst[i] = c[i];
      }
    }
    loadIdentity() {
      const c = new Float32Array([
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        1
      ]);
      this.setMatrix(c);
    }
    setMatrix(tr) {
      for (let i = 0; i < 16; ++i) {
        this._tr[i] = tr[i];
      }
    }
    getArray() {
      return this._tr;
    }
    getScaleX() {
      return this._tr[0];
    }
    getScaleY() {
      return this._tr[5];
    }
    getTranslateX() {
      return this._tr[12];
    }
    getTranslateY() {
      return this._tr[13];
    }
    transformX(src) {
      return this._tr[0] * src + this._tr[12];
    }
    transformY(src) {
      return this._tr[5] * src + this._tr[13];
    }
    invertTransformX(src) {
      return (src - this._tr[12]) / this._tr[0];
    }
    invertTransformY(src) {
      return (src - this._tr[13]) / this._tr[5];
    }
    translateRelative(x, y) {
      const tr1 = new Float32Array([
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        1,
        0,
        x,
        y,
        0,
        1
      ]);
      _CubismMatrix44.multiply(tr1, this._tr, this._tr);
    }
    translate(x, y) {
      this._tr[12] = x;
      this._tr[13] = y;
    }
    translateX(x) {
      this._tr[12] = x;
    }
    translateY(y) {
      this._tr[13] = y;
    }
    scaleRelative(x, y) {
      const tr1 = new Float32Array([
        x,
        0,
        0,
        0,
        0,
        y,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        1
      ]);
      _CubismMatrix44.multiply(tr1, this._tr, this._tr);
    }
    scale(x, y) {
      this._tr[0] = x;
      this._tr[5] = y;
    }
    multiplyByMatrix(m) {
      _CubismMatrix44.multiply(m.getArray(), this._tr, this._tr);
    }
    clone() {
      const cloneMatrix = new _CubismMatrix44();
      for (let i = 0; i < this._tr.length; i++) {
        cloneMatrix._tr[i] = this._tr[i];
      }
      return cloneMatrix;
    }
  };
  var CubismRenderer = class {
    initialize(model) {
      this._model = model;
    }
    drawModel() {
      if (this.getModel() == null)
        return;
      this.doDrawModel();
    }
    setMvpMatrix(matrix44) {
      this._mvpMatrix4x4.setMatrix(matrix44.getArray());
    }
    getMvpMatrix() {
      return this._mvpMatrix4x4;
    }
    setModelColor(red, green, blue, alpha) {
      if (red < 0) {
        red = 0;
      } else if (red > 1) {
        red = 1;
      }
      if (green < 0) {
        green = 0;
      } else if (green > 1) {
        green = 1;
      }
      if (blue < 0) {
        blue = 0;
      } else if (blue > 1) {
        blue = 1;
      }
      if (alpha < 0) {
        alpha = 0;
      } else if (alpha > 1) {
        alpha = 1;
      }
      this._modelColor.R = red;
      this._modelColor.G = green;
      this._modelColor.B = blue;
      this._modelColor.A = alpha;
    }
    getModelColor() {
      return Object.assign({}, this._modelColor);
    }
    setIsPremultipliedAlpha(enable) {
      this._isPremultipliedAlpha = enable;
    }
    isPremultipliedAlpha() {
      return this._isPremultipliedAlpha;
    }
    setIsCulling(culling) {
      this._isCulling = culling;
    }
    isCulling() {
      return this._isCulling;
    }
    setAnisotropy(n) {
      this._anisortopy = n;
    }
    getAnisotropy() {
      return this._anisortopy;
    }
    getModel() {
      return this._model;
    }
    constructor() {
      this._isCulling = false;
      this._isPremultipliedAlpha = false;
      this._anisortopy = 0;
      this._modelColor = new CubismTextureColor();
      this._mvpMatrix4x4 = new CubismMatrix44();
      this._mvpMatrix4x4.loadIdentity();
    }
  };
  var CubismBlendMode = /* @__PURE__ */ ((CubismBlendMode2) => {
    CubismBlendMode2[CubismBlendMode2["CubismBlendMode_Normal"] = 0] = "CubismBlendMode_Normal";
    CubismBlendMode2[CubismBlendMode2["CubismBlendMode_Additive"] = 1] = "CubismBlendMode_Additive";
    CubismBlendMode2[CubismBlendMode2["CubismBlendMode_Multiplicative"] = 2] = "CubismBlendMode_Multiplicative";
    return CubismBlendMode2;
  })(CubismBlendMode || {});
  var CubismTextureColor = class {
    constructor() {
      this.R = 1;
      this.G = 1;
      this.B = 1;
      this.A = 1;
    }
  };
  var s_isStarted = false;
  var s_isInitialized = false;
  var s_option = void 0;
  var Constant = {
    vertexOffset: 0,
    vertexStep: 2
  };
  var CubismFramework = class {
    static startUp(option) {
      if (s_isStarted) {
        CubismLogInfo("CubismFramework.startUp() is already done.");
        return s_isStarted;
      }
      if (Live2DCubismCore._isStarted) {
        s_isStarted = true;
        return true;
      }
      Live2DCubismCore._isStarted = true;
      s_option = option;
      if (s_option) {
        Live2DCubismCore.Logging.csmSetLogFunction(s_option.logFunction);
      }
      s_isStarted = true;
      if (s_isStarted) {
        const version = Live2DCubismCore.Version.csmGetVersion();
        const major = (version & 4278190080) >> 24;
        const minor = (version & 16711680) >> 16;
        const patch = version & 65535;
        const versionNumber = version;
        CubismLogInfo(`Live2D Cubism Core version: {0}.{1}.{2} ({3})`, ("00" + major).slice(-2), ("00" + minor).slice(-2), ("0000" + patch).slice(-4), versionNumber);
      }
      CubismLogInfo("CubismFramework.startUp() is complete.");
      return s_isStarted;
    }
    static cleanUp() {
      s_isStarted = false;
      s_isInitialized = false;
      s_option = void 0;
    }
    static initialize() {
      if (!s_isStarted) {
        CubismLogWarning("CubismFramework is not started.");
        return;
      }
      if (s_isInitialized) {
        CubismLogWarning("CubismFramework.initialize() skipped, already initialized.");
        return;
      }
      s_isInitialized = true;
      CubismLogInfo("CubismFramework.initialize() is complete.");
    }
    static dispose() {
      if (!s_isStarted) {
        CubismLogWarning("CubismFramework is not started.");
        return;
      }
      if (!s_isInitialized) {
        CubismLogWarning("CubismFramework.dispose() skipped, not initialized.");
        return;
      }
      CubismRenderer.staticRelease();
      s_isInitialized = false;
      CubismLogInfo("CubismFramework.dispose() is complete.");
    }
    static isStarted() {
      return s_isStarted;
    }
    static isInitialized() {
      return s_isInitialized;
    }
    static coreLogFunction(message) {
      if (!Live2DCubismCore.Logging.csmGetLogFunction()) {
        return;
      }
      Live2DCubismCore.Logging.csmGetLogFunction()(message);
    }
    static getLoggingLevel() {
      if (s_option != null) {
        return s_option.loggingLevel;
      }
      return LogLevel.LogLevel_Off;
    }
    constructor() {
    }
  };
  var LogLevel = /* @__PURE__ */ ((LogLevel2) => {
    LogLevel2[LogLevel2["LogLevel_Verbose"] = 0] = "LogLevel_Verbose";
    LogLevel2[LogLevel2["LogLevel_Debug"] = 1] = "LogLevel_Debug";
    LogLevel2[LogLevel2["LogLevel_Info"] = 2] = "LogLevel_Info";
    LogLevel2[LogLevel2["LogLevel_Warning"] = 3] = "LogLevel_Warning";
    LogLevel2[LogLevel2["LogLevel_Error"] = 4] = "LogLevel_Error";
    LogLevel2[LogLevel2["LogLevel_Off"] = 5] = "LogLevel_Off";
    return LogLevel2;
  })(LogLevel || {});
  var CSM_ASSERT = () => {
  };
  function CubismLogDebug(fmt, ...args) {
    CubismDebug.print(LogLevel.LogLevel_Debug, "[CSM][D]" + fmt + "\n", args);
  }
  function CubismLogInfo(fmt, ...args) {
    CubismDebug.print(LogLevel.LogLevel_Info, "[CSM][I]" + fmt + "\n", args);
  }
  function CubismLogWarning(fmt, ...args) {
    CubismDebug.print(LogLevel.LogLevel_Warning, "[CSM][W]" + fmt + "\n", args);
  }
  function CubismLogError(fmt, ...args) {
    CubismDebug.print(LogLevel.LogLevel_Error, "[CSM][E]" + fmt + "\n", args);
  }
  var CubismDebug = class {
    static print(logLevel, format2, args) {
      if (logLevel < CubismFramework.getLoggingLevel()) {
        return;
      }
      const logPrint = CubismFramework.coreLogFunction;
      if (!logPrint)
        return;
      const buffer = format2.replace(/{(\d+)}/g, (m, k) => {
        return args[k];
      });
      logPrint(buffer);
    }
    static dumpBytes(logLevel, data, length) {
      for (let i = 0; i < length; i++) {
        if (i % 16 == 0 && i > 0)
          this.print(logLevel, "\n");
        else if (i % 8 == 0 && i > 0)
          this.print(logLevel, "  ");
        this.print(logLevel, "{0} ", [data[i] & 255]);
      }
      this.print(logLevel, "\n");
    }
    constructor() {
    }
  };
  var CubismModel = class {
    update() {
      this._model.update();
      this._model.drawables.resetDynamicFlags();
    }
    getCanvasWidth() {
      if (this._model == null) {
        return 0;
      }
      return this._model.canvasinfo.CanvasWidth / this._model.canvasinfo.PixelsPerUnit;
    }
    getCanvasHeight() {
      if (this._model == null) {
        return 0;
      }
      return this._model.canvasinfo.CanvasHeight / this._model.canvasinfo.PixelsPerUnit;
    }
    saveParameters() {
      const parameterCount = this._model.parameters.count;
      const savedParameterCount = this._savedParameters.length;
      for (let i = 0; i < parameterCount; ++i) {
        if (i < savedParameterCount) {
          this._savedParameters[i] = this._parameterValues[i];
        } else {
          this._savedParameters.push(this._parameterValues[i]);
        }
      }
    }
    getModel() {
      return this._model;
    }
    getPartIndex(partId) {
      let partIndex;
      const partCount = this._model.parts.count;
      for (partIndex = 0; partIndex < partCount; ++partIndex) {
        if (partId == this._partIds[partIndex]) {
          return partIndex;
        }
      }
      if (partId in this._notExistPartId) {
        return this._notExistPartId[partId];
      }
      partIndex = partCount + this._notExistPartId.length;
      this._notExistPartId[partId] = partIndex;
      this._notExistPartOpacities[partIndex] = 0;
      return partIndex;
    }
    getPartCount() {
      return this._model.parts.count;
    }
    setPartOpacityByIndex(partIndex, opacity) {
      if (partIndex in this._notExistPartOpacities) {
        this._notExistPartOpacities[partIndex] = opacity;
        return;
      }
      CSM_ASSERT(0 <= partIndex && partIndex < this.getPartCount());
      this._partOpacities[partIndex] = opacity;
    }
    setPartOpacityById(partId, opacity) {
      const index = this.getPartIndex(partId);
      if (index < 0) {
        return;
      }
      this.setPartOpacityByIndex(index, opacity);
    }
    getPartOpacityByIndex(partIndex) {
      if (partIndex in this._notExistPartOpacities) {
        return this._notExistPartOpacities[partIndex];
      }
      CSM_ASSERT(0 <= partIndex && partIndex < this.getPartCount());
      return this._partOpacities[partIndex];
    }
    getPartOpacityById(partId) {
      const index = this.getPartIndex(partId);
      if (index < 0) {
        return 0;
      }
      return this.getPartOpacityByIndex(index);
    }
    getParameterIndex(parameterId) {
      let parameterIndex;
      const idCount = this._model.parameters.count;
      for (parameterIndex = 0; parameterIndex < idCount; ++parameterIndex) {
        if (parameterId != this._parameterIds[parameterIndex]) {
          continue;
        }
        return parameterIndex;
      }
      if (parameterId in this._notExistParameterId) {
        return this._notExistParameterId[parameterId];
      }
      parameterIndex = this._model.parameters.count + Object.keys(this._notExistParameterId).length;
      this._notExistParameterId[parameterId] = parameterIndex;
      this._notExistParameterValues[parameterIndex] = 0;
      return parameterIndex;
    }
    getParameterCount() {
      return this._model.parameters.count;
    }
    getParameterMaximumValue(parameterIndex) {
      return this._model.parameters.maximumValues[parameterIndex];
    }
    getParameterMinimumValue(parameterIndex) {
      return this._model.parameters.minimumValues[parameterIndex];
    }
    getParameterDefaultValue(parameterIndex) {
      return this._model.parameters.defaultValues[parameterIndex];
    }
    getParameterValueByIndex(parameterIndex) {
      if (parameterIndex in this._notExistParameterValues) {
        return this._notExistParameterValues[parameterIndex];
      }
      CSM_ASSERT(0 <= parameterIndex && parameterIndex < this.getParameterCount());
      return this._parameterValues[parameterIndex];
    }
    getParameterValueById(parameterId) {
      const parameterIndex = this.getParameterIndex(parameterId);
      return this.getParameterValueByIndex(parameterIndex);
    }
    setParameterValueByIndex(parameterIndex, value, weight = 1) {
      if (parameterIndex in this._notExistParameterValues) {
        this._notExistParameterValues[parameterIndex] = weight == 1 ? value : this._notExistParameterValues[parameterIndex] * (1 - weight) + value * weight;
        return;
      }
      CSM_ASSERT(0 <= parameterIndex && parameterIndex < this.getParameterCount());
      if (this._model.parameters.maximumValues[parameterIndex] < value) {
        value = this._model.parameters.maximumValues[parameterIndex];
      }
      if (this._model.parameters.minimumValues[parameterIndex] > value) {
        value = this._model.parameters.minimumValues[parameterIndex];
      }
      this._parameterValues[parameterIndex] = weight == 1 ? value : this._parameterValues[parameterIndex] = this._parameterValues[parameterIndex] * (1 - weight) + value * weight;
    }
    setParameterValueById(parameterId, value, weight = 1) {
      const index = this.getParameterIndex(parameterId);
      this.setParameterValueByIndex(index, value, weight);
    }
    addParameterValueByIndex(parameterIndex, value, weight = 1) {
      this.setParameterValueByIndex(parameterIndex, this.getParameterValueByIndex(parameterIndex) + value * weight);
    }
    addParameterValueById(parameterId, value, weight = 1) {
      const index = this.getParameterIndex(parameterId);
      this.addParameterValueByIndex(index, value, weight);
    }
    multiplyParameterValueById(parameterId, value, weight = 1) {
      const index = this.getParameterIndex(parameterId);
      this.multiplyParameterValueByIndex(index, value, weight);
    }
    multiplyParameterValueByIndex(parameterIndex, value, weight = 1) {
      this.setParameterValueByIndex(parameterIndex, this.getParameterValueByIndex(parameterIndex) * (1 + (value - 1) * weight));
    }
    getDrawableIds() {
      return this._drawableIds.slice();
    }
    getDrawableIndex(drawableId) {
      const drawableCount = this._model.drawables.count;
      for (let drawableIndex = 0; drawableIndex < drawableCount; ++drawableIndex) {
        if (this._drawableIds[drawableIndex] == drawableId) {
          return drawableIndex;
        }
      }
      return -1;
    }
    getDrawableCount() {
      return this._model.drawables.count;
    }
    getDrawableId(drawableIndex) {
      return this._model.drawables.ids[drawableIndex];
    }
    getDrawableRenderOrders() {
      return this._model.drawables.renderOrders;
    }
    getDrawableTextureIndices(drawableIndex) {
      return this._model.drawables.textureIndices[drawableIndex];
    }
    getDrawableDynamicFlagVertexPositionsDidChange(drawableIndex) {
      const dynamicFlags = this._model.drawables.dynamicFlags;
      return Live2DCubismCore.Utils.hasVertexPositionsDidChangeBit(dynamicFlags[drawableIndex]);
    }
    getDrawableVertexIndexCount(drawableIndex) {
      return this._model.drawables.indexCounts[drawableIndex];
    }
    getDrawableVertexCount(drawableIndex) {
      return this._model.drawables.vertexCounts[drawableIndex];
    }
    getDrawableVertices(drawableIndex) {
      return this.getDrawableVertexPositions(drawableIndex);
    }
    getDrawableVertexIndices(drawableIndex) {
      return this._model.drawables.indices[drawableIndex];
    }
    getDrawableVertexPositions(drawableIndex) {
      return this._model.drawables.vertexPositions[drawableIndex];
    }
    getDrawableVertexUvs(drawableIndex) {
      return this._model.drawables.vertexUvs[drawableIndex];
    }
    getDrawableOpacity(drawableIndex) {
      return this._model.drawables.opacities[drawableIndex];
    }
    getDrawableCulling(drawableIndex) {
      const constantFlags = this._model.drawables.constantFlags;
      return !Live2DCubismCore.Utils.hasIsDoubleSidedBit(constantFlags[drawableIndex]);
    }
    getDrawableBlendMode(drawableIndex) {
      const constantFlags = this._model.drawables.constantFlags;
      return Live2DCubismCore.Utils.hasBlendAdditiveBit(constantFlags[drawableIndex]) ? CubismBlendMode.CubismBlendMode_Additive : Live2DCubismCore.Utils.hasBlendMultiplicativeBit(constantFlags[drawableIndex]) ? CubismBlendMode.CubismBlendMode_Multiplicative : CubismBlendMode.CubismBlendMode_Normal;
    }
    getDrawableInvertedMaskBit(drawableIndex) {
      const constantFlags = this._model.drawables.constantFlags;
      return Live2DCubismCore.Utils.hasIsInvertedMaskBit(constantFlags[drawableIndex]);
    }
    getDrawableMasks() {
      return this._model.drawables.masks;
    }
    getDrawableMaskCounts() {
      return this._model.drawables.maskCounts;
    }
    isUsingMasking() {
      for (let d = 0; d < this._model.drawables.count; ++d) {
        if (this._model.drawables.maskCounts[d] <= 0) {
          continue;
        }
        return true;
      }
      return false;
    }
    getDrawableDynamicFlagIsVisible(drawableIndex) {
      const dynamicFlags = this._model.drawables.dynamicFlags;
      return Live2DCubismCore.Utils.hasIsVisibleBit(dynamicFlags[drawableIndex]);
    }
    getDrawableDynamicFlagVisibilityDidChange(drawableIndex) {
      const dynamicFlags = this._model.drawables.dynamicFlags;
      return Live2DCubismCore.Utils.hasVisibilityDidChangeBit(dynamicFlags[drawableIndex]);
    }
    getDrawableDynamicFlagOpacityDidChange(drawableIndex) {
      const dynamicFlags = this._model.drawables.dynamicFlags;
      return Live2DCubismCore.Utils.hasOpacityDidChangeBit(dynamicFlags[drawableIndex]);
    }
    getDrawableDynamicFlagRenderOrderDidChange(drawableIndex) {
      const dynamicFlags = this._model.drawables.dynamicFlags;
      return Live2DCubismCore.Utils.hasRenderOrderDidChangeBit(dynamicFlags[drawableIndex]);
    }
    loadParameters() {
      let parameterCount = this._model.parameters.count;
      const savedParameterCount = this._savedParameters.length;
      if (parameterCount > savedParameterCount) {
        parameterCount = savedParameterCount;
      }
      for (let i = 0; i < parameterCount; ++i) {
        this._parameterValues[i] = this._savedParameters[i];
      }
    }
    initialize() {
      this._parameterValues = this._model.parameters.values;
      this._partOpacities = this._model.parts.opacities;
      this._parameterMaximumValues = this._model.parameters.maximumValues;
      this._parameterMinimumValues = this._model.parameters.minimumValues;
      {
        const parameterIds = this._model.parameters.ids;
        const parameterCount = this._model.parameters.count;
        for (let i = 0; i < parameterCount; ++i) {
          this._parameterIds.push(parameterIds[i]);
        }
      }
      {
        const partIds = this._model.parts.ids;
        const partCount = this._model.parts.count;
        for (let i = 0; i < partCount; ++i) {
          this._partIds.push(partIds[i]);
        }
      }
      {
        const drawableIds = this._model.drawables.ids;
        const drawableCount = this._model.drawables.count;
        for (let i = 0; i < drawableCount; ++i) {
          this._drawableIds.push(drawableIds[i]);
        }
      }
    }
    constructor(model) {
      this._model = model;
      this._savedParameters = [];
      this._parameterIds = [];
      this._drawableIds = [];
      this._partIds = [];
      this._notExistPartId = {};
      this._notExistParameterId = {};
      this._notExistParameterValues = {};
      this._notExistPartOpacities = {};
      this.initialize();
    }
    release() {
      this._model.release();
      this._model = void 0;
    }
  };
  var CubismMoc = class _CubismMoc {
    static create(mocBytes) {
      const moc = Live2DCubismCore.Moc.fromArrayBuffer(mocBytes);
      if (moc) {
        return new _CubismMoc(moc);
      }
      throw new Error("Unknown error");
    }
    createModel() {
      let cubismModel;
      const model = Live2DCubismCore.Model.fromMoc(this._moc);
      if (model) {
        cubismModel = new CubismModel(model);
        ++this._modelCount;
        return cubismModel;
      }
      throw new Error("Unknown error");
    }
    deleteModel(model) {
      if (model != null) {
        --this._modelCount;
      }
    }
    constructor(moc) {
      this._moc = moc;
      this._modelCount = 0;
    }
    release() {
      this._moc._release();
      this._moc = void 0;
    }
  };
  var ACubismMotion = class {
    constructor() {
      this._fadeInSeconds = -1;
      this._fadeOutSeconds = -1;
      this._weight = 1;
      this._offsetSeconds = 0;
      this._firedEventValues = [];
    }
    release() {
      this._weight = 0;
    }
    updateParameters(model, motionQueueEntry, userTimeSeconds) {
      if (!motionQueueEntry.isAvailable() || motionQueueEntry.isFinished()) {
        return;
      }
      if (!motionQueueEntry.isStarted()) {
        motionQueueEntry.setIsStarted(true);
        motionQueueEntry.setStartTime(userTimeSeconds - this._offsetSeconds);
        motionQueueEntry.setFadeInStartTime(userTimeSeconds);
        const duration = this.getDuration();
        if (motionQueueEntry.getEndTime() < 0) {
          motionQueueEntry.setEndTime(duration <= 0 ? -1 : motionQueueEntry.getStartTime() + duration);
        }
      }
      let fadeWeight = this._weight;
      const fadeIn = this._fadeInSeconds == 0 ? 1 : CubismMath.getEasingSine((userTimeSeconds - motionQueueEntry.getFadeInStartTime()) / this._fadeInSeconds);
      const fadeOut = this._fadeOutSeconds == 0 || motionQueueEntry.getEndTime() < 0 ? 1 : CubismMath.getEasingSine((motionQueueEntry.getEndTime() - userTimeSeconds) / this._fadeOutSeconds);
      fadeWeight = fadeWeight * fadeIn * fadeOut;
      motionQueueEntry.setState(userTimeSeconds, fadeWeight);
      this.doUpdateParameters(model, userTimeSeconds, fadeWeight, motionQueueEntry);
      if (motionQueueEntry.getEndTime() > 0 && motionQueueEntry.getEndTime() < userTimeSeconds) {
        motionQueueEntry.setIsFinished(true);
      }
    }
    setFadeInTime(fadeInSeconds) {
      this._fadeInSeconds = fadeInSeconds;
    }
    setFadeOutTime(fadeOutSeconds) {
      this._fadeOutSeconds = fadeOutSeconds;
    }
    getFadeOutTime() {
      return this._fadeOutSeconds;
    }
    getFadeInTime() {
      return this._fadeInSeconds;
    }
    setWeight(weight) {
      this._weight = weight;
    }
    getWeight() {
      return this._weight;
    }
    getDuration() {
      return -1;
    }
    getLoopDuration() {
      return -1;
    }
    setOffsetTime(offsetSeconds) {
      this._offsetSeconds = offsetSeconds;
    }
    getFiredEvent(beforeCheckTimeSeconds, motionTimeSeconds) {
      return this._firedEventValues;
    }
    setFinishedMotionHandler(onFinishedMotionHandler) {
      this._onFinishedMotion = onFinishedMotionHandler;
    }
    getFinishedMotionHandler() {
      return this._onFinishedMotion;
    }
  };
  var DefaultFadeTime = 1;
  var CubismExpressionMotion = class _CubismExpressionMotion extends ACubismMotion {
    constructor() {
      super();
      this._parameters = [];
    }
    static create(json) {
      const expression = new _CubismExpressionMotion();
      const fadeInTime = json.FadeInTime;
      const fadeOutTime = json.FadeOutTime;
      expression.setFadeInTime(fadeInTime !== void 0 ? fadeInTime : DefaultFadeTime);
      expression.setFadeOutTime(fadeOutTime !== void 0 ? fadeOutTime : DefaultFadeTime);
      const parameters = json.Parameters || [];
      for (let i = 0; i < parameters.length; ++i) {
        const param = parameters[i];
        const parameterId = param.Id;
        const value = param.Value;
        let blendType;
        switch (param.Blend) {
          case "Multiply":
            blendType = ExpressionBlendType.ExpressionBlendType_Multiply;
            break;
          case "Overwrite":
            blendType = ExpressionBlendType.ExpressionBlendType_Overwrite;
            break;
          case "Add":
          default:
            blendType = ExpressionBlendType.ExpressionBlendType_Add;
            break;
        }
        const item = {
          parameterId,
          blendType,
          value
        };
        expression._parameters.push(item);
      }
      return expression;
    }
    doUpdateParameters(model, userTimeSeconds, weight, motionQueueEntry) {
      for (let i = 0; i < this._parameters.length; ++i) {
        const parameter = this._parameters[i];
        switch (parameter.blendType) {
          case ExpressionBlendType.ExpressionBlendType_Add: {
            model.addParameterValueById(parameter.parameterId, parameter.value, weight);
            break;
          }
          case ExpressionBlendType.ExpressionBlendType_Multiply: {
            model.multiplyParameterValueById(parameter.parameterId, parameter.value, weight);
            break;
          }
          case ExpressionBlendType.ExpressionBlendType_Overwrite: {
            model.setParameterValueById(parameter.parameterId, parameter.value, weight);
            break;
          }
        }
      }
    }
  };
  var ExpressionBlendType = /* @__PURE__ */ ((ExpressionBlendType2) => {
    ExpressionBlendType2[ExpressionBlendType2["ExpressionBlendType_Add"] = 0] = "ExpressionBlendType_Add";
    ExpressionBlendType2[ExpressionBlendType2["ExpressionBlendType_Multiply"] = 1] = "ExpressionBlendType_Multiply";
    ExpressionBlendType2[ExpressionBlendType2["ExpressionBlendType_Overwrite"] = 2] = "ExpressionBlendType_Overwrite";
    return ExpressionBlendType2;
  })(ExpressionBlendType || {});
  var CubismConfig;
  ((CubismConfig2) => {
    CubismConfig2.supportMoreMaskDivisions = true;
    CubismConfig2.setOpacityFromMotion = false;
  })(CubismConfig || (CubismConfig = {}));
  var CubismMotionCurveTarget = /* @__PURE__ */ ((CubismMotionCurveTarget2) => {
    CubismMotionCurveTarget2[CubismMotionCurveTarget2["CubismMotionCurveTarget_Model"] = 0] = "CubismMotionCurveTarget_Model";
    CubismMotionCurveTarget2[CubismMotionCurveTarget2["CubismMotionCurveTarget_Parameter"] = 1] = "CubismMotionCurveTarget_Parameter";
    CubismMotionCurveTarget2[CubismMotionCurveTarget2["CubismMotionCurveTarget_PartOpacity"] = 2] = "CubismMotionCurveTarget_PartOpacity";
    return CubismMotionCurveTarget2;
  })(CubismMotionCurveTarget || {});
  var CubismMotionSegmentType = /* @__PURE__ */ ((CubismMotionSegmentType2) => {
    CubismMotionSegmentType2[CubismMotionSegmentType2["CubismMotionSegmentType_Linear"] = 0] = "CubismMotionSegmentType_Linear";
    CubismMotionSegmentType2[CubismMotionSegmentType2["CubismMotionSegmentType_Bezier"] = 1] = "CubismMotionSegmentType_Bezier";
    CubismMotionSegmentType2[CubismMotionSegmentType2["CubismMotionSegmentType_Stepped"] = 2] = "CubismMotionSegmentType_Stepped";
    CubismMotionSegmentType2[CubismMotionSegmentType2["CubismMotionSegmentType_InverseStepped"] = 3] = "CubismMotionSegmentType_InverseStepped";
    return CubismMotionSegmentType2;
  })(CubismMotionSegmentType || {});
  var CubismMotionPoint = class {
    constructor(time = 0, value = 0) {
      this.time = time;
      this.value = value;
    }
  };
  var CubismMotionSegment = class {
    constructor() {
      this.basePointIndex = 0;
      this.segmentType = 0;
    }
  };
  var CubismMotionCurve = class {
    constructor() {
      this.id = "";
      this.type = 0;
      this.segmentCount = 0;
      this.baseSegmentIndex = 0;
      this.fadeInTime = 0;
      this.fadeOutTime = 0;
    }
  };
  var CubismMotionEvent = class {
    constructor() {
      this.fireTime = 0;
      this.value = "";
    }
  };
  var CubismMotionData = class {
    constructor() {
      this.duration = 0;
      this.loop = false;
      this.curveCount = 0;
      this.eventCount = 0;
      this.fps = 0;
      this.curves = [];
      this.segments = [];
      this.points = [];
      this.events = [];
    }
  };
  var CubismMotionJson = class {
    constructor(json) {
      this._json = json;
    }
    release() {
      this._json = void 0;
    }
    getMotionDuration() {
      return this._json.Meta.Duration;
    }
    isMotionLoop() {
      return this._json.Meta.Loop || false;
    }
    getEvaluationOptionFlag(flagType) {
      if (EvaluationOptionFlag.EvaluationOptionFlag_AreBeziersRistricted == flagType) {
        return !!this._json.Meta.AreBeziersRestricted;
      }
      return false;
    }
    getMotionCurveCount() {
      return this._json.Meta.CurveCount;
    }
    getMotionFps() {
      return this._json.Meta.Fps;
    }
    getMotionTotalSegmentCount() {
      return this._json.Meta.TotalSegmentCount;
    }
    getMotionTotalPointCount() {
      return this._json.Meta.TotalPointCount;
    }
    getMotionFadeInTime() {
      return this._json.Meta.FadeInTime;
    }
    getMotionFadeOutTime() {
      return this._json.Meta.FadeOutTime;
    }
    getMotionCurveTarget(curveIndex) {
      return this._json.Curves[curveIndex].Target;
    }
    getMotionCurveId(curveIndex) {
      return this._json.Curves[curveIndex].Id;
    }
    getMotionCurveFadeInTime(curveIndex) {
      return this._json.Curves[curveIndex].FadeInTime;
    }
    getMotionCurveFadeOutTime(curveIndex) {
      return this._json.Curves[curveIndex].FadeOutTime;
    }
    getMotionCurveSegmentCount(curveIndex) {
      return this._json.Curves[curveIndex].Segments.length;
    }
    getMotionCurveSegment(curveIndex, segmentIndex) {
      return this._json.Curves[curveIndex].Segments[segmentIndex];
    }
    getEventCount() {
      return this._json.Meta.UserDataCount || 0;
    }
    getTotalEventValueSize() {
      return this._json.Meta.TotalUserDataSize;
    }
    getEventTime(userDataIndex) {
      return this._json.UserData[userDataIndex].Time;
    }
    getEventValue(userDataIndex) {
      return this._json.UserData[userDataIndex].Value;
    }
  };
  var EvaluationOptionFlag = /* @__PURE__ */ ((EvaluationOptionFlag2) => {
    EvaluationOptionFlag2[EvaluationOptionFlag2["EvaluationOptionFlag_AreBeziersRistricted"] = 0] = "EvaluationOptionFlag_AreBeziersRistricted";
    return EvaluationOptionFlag2;
  })(EvaluationOptionFlag || {});
  var EffectNameEyeBlink = "EyeBlink";
  var EffectNameLipSync = "LipSync";
  var TargetNameModel = "Model";
  var TargetNameParameter = "Parameter";
  var TargetNamePartOpacity = "PartOpacity";
  var UseOldBeziersCurveMotion = false;
  function lerpPoints(a, b, t) {
    const result = new CubismMotionPoint();
    result.time = a.time + (b.time - a.time) * t;
    result.value = a.value + (b.value - a.value) * t;
    return result;
  }
  function linearEvaluate(points, time) {
    let t = (time - points[0].time) / (points[1].time - points[0].time);
    if (t < 0) {
      t = 0;
    }
    return points[0].value + (points[1].value - points[0].value) * t;
  }
  function bezierEvaluate(points, time) {
    let t = (time - points[0].time) / (points[3].time - points[0].time);
    if (t < 0) {
      t = 0;
    }
    const p01 = lerpPoints(points[0], points[1], t);
    const p12 = lerpPoints(points[1], points[2], t);
    const p23 = lerpPoints(points[2], points[3], t);
    const p012 = lerpPoints(p01, p12, t);
    const p123 = lerpPoints(p12, p23, t);
    return lerpPoints(p012, p123, t).value;
  }
  function bezierEvaluateCardanoInterpretation(points, time) {
    const x = time;
    const x1 = points[0].time;
    const x2 = points[3].time;
    const cx1 = points[1].time;
    const cx2 = points[2].time;
    const a = x2 - 3 * cx2 + 3 * cx1 - x1;
    const b = 3 * cx2 - 6 * cx1 + 3 * x1;
    const c = 3 * cx1 - 3 * x1;
    const d = x1 - x;
    const t = CubismMath.cardanoAlgorithmForBezier(a, b, c, d);
    const p01 = lerpPoints(points[0], points[1], t);
    const p12 = lerpPoints(points[1], points[2], t);
    const p23 = lerpPoints(points[2], points[3], t);
    const p012 = lerpPoints(p01, p12, t);
    const p123 = lerpPoints(p12, p23, t);
    return lerpPoints(p012, p123, t).value;
  }
  function steppedEvaluate(points, time) {
    return points[0].value;
  }
  function inverseSteppedEvaluate(points, time) {
    return points[1].value;
  }
  function evaluateCurve(motionData, index, time) {
    const curve = motionData.curves[index];
    let target = -1;
    const totalSegmentCount = curve.baseSegmentIndex + curve.segmentCount;
    let pointPosition = 0;
    for (let i = curve.baseSegmentIndex; i < totalSegmentCount; ++i) {
      pointPosition = motionData.segments[i].basePointIndex + (motionData.segments[i].segmentType == CubismMotionSegmentType.CubismMotionSegmentType_Bezier ? 3 : 1);
      if (motionData.points[pointPosition].time > time) {
        target = i;
        break;
      }
    }
    if (target == -1) {
      return motionData.points[pointPosition].value;
    }
    const segment = motionData.segments[target];
    return segment.evaluate(motionData.points.slice(segment.basePointIndex), time);
  }
  var CubismMotion = class _CubismMotion extends ACubismMotion {
    constructor() {
      super();
      this._eyeBlinkParameterIds = [];
      this._lipSyncParameterIds = [];
      this._sourceFrameRate = 30;
      this._loopDurationSeconds = -1;
      this._isLoop = false;
      this._isLoopFadeIn = true;
      this._lastWeight = 0;
    }
    static create(json, onFinishedMotionHandler) {
      const ret = new _CubismMotion();
      ret.parse(json);
      ret._sourceFrameRate = ret._motionData.fps;
      ret._loopDurationSeconds = ret._motionData.duration;
      ret._onFinishedMotion = onFinishedMotionHandler;
      return ret;
    }
    doUpdateParameters(model, userTimeSeconds, fadeWeight, motionQueueEntry) {
      if (this._modelCurveIdEyeBlink == null) {
        this._modelCurveIdEyeBlink = EffectNameEyeBlink;
      }
      if (this._modelCurveIdLipSync == null) {
        this._modelCurveIdLipSync = EffectNameLipSync;
      }
      let timeOffsetSeconds = userTimeSeconds - motionQueueEntry.getStartTime();
      if (timeOffsetSeconds < 0) {
        timeOffsetSeconds = 0;
      }
      let lipSyncValue = Number.MAX_VALUE;
      let eyeBlinkValue = Number.MAX_VALUE;
      const MaxTargetSize = 64;
      let lipSyncFlags = 0;
      let eyeBlinkFlags = 0;
      if (this._eyeBlinkParameterIds.length > MaxTargetSize) {
        CubismLogDebug("too many eye blink targets : {0}", this._eyeBlinkParameterIds.length);
      }
      if (this._lipSyncParameterIds.length > MaxTargetSize) {
        CubismLogDebug("too many lip sync targets : {0}", this._lipSyncParameterIds.length);
      }
      const tmpFadeIn = this._fadeInSeconds <= 0 ? 1 : CubismMath.getEasingSine((userTimeSeconds - motionQueueEntry.getFadeInStartTime()) / this._fadeInSeconds);
      const tmpFadeOut = this._fadeOutSeconds <= 0 || motionQueueEntry.getEndTime() < 0 ? 1 : CubismMath.getEasingSine((motionQueueEntry.getEndTime() - userTimeSeconds) / this._fadeOutSeconds);
      let value;
      let c, parameterIndex;
      let time = timeOffsetSeconds;
      if (this._isLoop) {
        while (time > this._motionData.duration) {
          time -= this._motionData.duration;
        }
      }
      const curves = this._motionData.curves;
      for (c = 0; c < this._motionData.curveCount && curves[c].type == CubismMotionCurveTarget.CubismMotionCurveTarget_Model; ++c) {
        value = evaluateCurve(this._motionData, c, time);
        if (curves[c].id == this._modelCurveIdEyeBlink) {
          eyeBlinkValue = value;
        } else if (curves[c].id == this._modelCurveIdLipSync) {
          lipSyncValue = value;
        }
      }
      for (; c < this._motionData.curveCount && curves[c].type == CubismMotionCurveTarget.CubismMotionCurveTarget_Parameter; ++c) {
        parameterIndex = model.getParameterIndex(curves[c].id);
        if (parameterIndex == -1) {
          continue;
        }
        const sourceValue = model.getParameterValueByIndex(parameterIndex);
        value = evaluateCurve(this._motionData, c, time);
        if (eyeBlinkValue != Number.MAX_VALUE) {
          for (let i = 0; i < this._eyeBlinkParameterIds.length && i < MaxTargetSize; ++i) {
            if (this._eyeBlinkParameterIds[i] == curves[c].id) {
              value *= eyeBlinkValue;
              eyeBlinkFlags |= 1 << i;
              break;
            }
          }
        }
        if (lipSyncValue != Number.MAX_VALUE) {
          for (let i = 0; i < this._lipSyncParameterIds.length && i < MaxTargetSize; ++i) {
            if (this._lipSyncParameterIds[i] == curves[c].id) {
              value += lipSyncValue;
              lipSyncFlags |= 1 << i;
              break;
            }
          }
        }
        let v;
        if (curves[c].fadeInTime < 0 && curves[c].fadeOutTime < 0) {
          v = sourceValue + (value - sourceValue) * fadeWeight;
        } else {
          let fin;
          let fout;
          if (curves[c].fadeInTime < 0) {
            fin = tmpFadeIn;
          } else {
            fin = curves[c].fadeInTime == 0 ? 1 : CubismMath.getEasingSine((userTimeSeconds - motionQueueEntry.getFadeInStartTime()) / curves[c].fadeInTime);
          }
          if (curves[c].fadeOutTime < 0) {
            fout = tmpFadeOut;
          } else {
            fout = curves[c].fadeOutTime == 0 || motionQueueEntry.getEndTime() < 0 ? 1 : CubismMath.getEasingSine((motionQueueEntry.getEndTime() - userTimeSeconds) / curves[c].fadeOutTime);
          }
          const paramWeight = this._weight * fin * fout;
          v = sourceValue + (value - sourceValue) * paramWeight;
        }
        model.setParameterValueByIndex(parameterIndex, v, 1);
      }
      {
        if (eyeBlinkValue != Number.MAX_VALUE) {
          for (let i = 0; i < this._eyeBlinkParameterIds.length && i < MaxTargetSize; ++i) {
            const sourceValue = model.getParameterValueById(this._eyeBlinkParameterIds[i]);
            if (eyeBlinkFlags >> i & 1) {
              continue;
            }
            const v = sourceValue + (eyeBlinkValue - sourceValue) * fadeWeight;
            model.setParameterValueById(this._eyeBlinkParameterIds[i], v);
          }
        }
        if (lipSyncValue != Number.MAX_VALUE) {
          for (let i = 0; i < this._lipSyncParameterIds.length && i < MaxTargetSize; ++i) {
            const sourceValue = model.getParameterValueById(this._lipSyncParameterIds[i]);
            if (lipSyncFlags >> i & 1) {
              continue;
            }
            const v = sourceValue + (lipSyncValue - sourceValue) * fadeWeight;
            model.setParameterValueById(this._lipSyncParameterIds[i], v);
          }
        }
      }
      for (; c < this._motionData.curveCount && curves[c].type == CubismMotionCurveTarget.CubismMotionCurveTarget_PartOpacity; ++c) {
        value = evaluateCurve(this._motionData, c, time);
        if (CubismConfig.setOpacityFromMotion) {
          model.setPartOpacityById(curves[c].id, value);
        } else {
          parameterIndex = model.getParameterIndex(curves[c].id);
          if (parameterIndex == -1) {
            continue;
          }
          model.setParameterValueByIndex(parameterIndex, value);
        }
      }
      if (timeOffsetSeconds >= this._motionData.duration) {
        if (this._isLoop) {
          motionQueueEntry.setStartTime(userTimeSeconds);
          if (this._isLoopFadeIn) {
            motionQueueEntry.setFadeInStartTime(userTimeSeconds);
          }
        } else {
          if (this._onFinishedMotion) {
            this._onFinishedMotion(this);
          }
          motionQueueEntry.setIsFinished(true);
        }
      }
      this._lastWeight = fadeWeight;
    }
    setIsLoop(loop) {
      this._isLoop = loop;
    }
    isLoop() {
      return this._isLoop;
    }
    setIsLoopFadeIn(loopFadeIn) {
      this._isLoopFadeIn = loopFadeIn;
    }
    isLoopFadeIn() {
      return this._isLoopFadeIn;
    }
    getDuration() {
      return this._isLoop ? -1 : this._loopDurationSeconds;
    }
    getLoopDuration() {
      return this._loopDurationSeconds;
    }
    setParameterFadeInTime(parameterId, value) {
      const curves = this._motionData.curves;
      for (let i = 0; i < this._motionData.curveCount; ++i) {
        if (parameterId == curves[i].id) {
          curves[i].fadeInTime = value;
          return;
        }
      }
    }
    setParameterFadeOutTime(parameterId, value) {
      const curves = this._motionData.curves;
      for (let i = 0; i < this._motionData.curveCount; ++i) {
        if (parameterId == curves[i].id) {
          curves[i].fadeOutTime = value;
          return;
        }
      }
    }
    getParameterFadeInTime(parameterId) {
      const curves = this._motionData.curves;
      for (let i = 0; i < this._motionData.curveCount; ++i) {
        if (parameterId == curves[i].id) {
          return curves[i].fadeInTime;
        }
      }
      return -1;
    }
    getParameterFadeOutTime(parameterId) {
      const curves = this._motionData.curves;
      for (let i = 0; i < this._motionData.curveCount; ++i) {
        if (parameterId == curves[i].id) {
          return curves[i].fadeOutTime;
        }
      }
      return -1;
    }
    setEffectIds(eyeBlinkParameterIds, lipSyncParameterIds) {
      this._eyeBlinkParameterIds = eyeBlinkParameterIds;
      this._lipSyncParameterIds = lipSyncParameterIds;
    }
    release() {
      this._motionData = void 0;
    }
    parse(motionJson) {
      this._motionData = new CubismMotionData();
      let json = new CubismMotionJson(motionJson);
      this._motionData.duration = json.getMotionDuration();
      this._motionData.loop = json.isMotionLoop();
      this._motionData.curveCount = json.getMotionCurveCount();
      this._motionData.fps = json.getMotionFps();
      this._motionData.eventCount = json.getEventCount();
      const areBeziersRestructed = json.getEvaluationOptionFlag(EvaluationOptionFlag.EvaluationOptionFlag_AreBeziersRistricted);
      const fadeInSeconds = json.getMotionFadeInTime();
      const fadeOutSeconds = json.getMotionFadeOutTime();
      if (fadeInSeconds !== void 0) {
        this._fadeInSeconds = fadeInSeconds < 0 ? 1 : fadeInSeconds;
      } else {
        this._fadeInSeconds = 1;
      }
      if (fadeOutSeconds !== void 0) {
        this._fadeOutSeconds = fadeOutSeconds < 0 ? 1 : fadeOutSeconds;
      } else {
        this._fadeOutSeconds = 1;
      }
      this._motionData.curves = Array.from({ length: this._motionData.curveCount }).map(() => new CubismMotionCurve());
      this._motionData.segments = Array.from({ length: json.getMotionTotalSegmentCount() }).map(() => new CubismMotionSegment());
      this._motionData.events = Array.from({ length: this._motionData.eventCount }).map(() => new CubismMotionEvent());
      this._motionData.points = [];
      let totalPointCount = 0;
      let totalSegmentCount = 0;
      for (let curveCount = 0; curveCount < this._motionData.curveCount; ++curveCount) {
        const curve = this._motionData.curves[curveCount];
        switch (json.getMotionCurveTarget(curveCount)) {
          case TargetNameModel:
            curve.type = CubismMotionCurveTarget.CubismMotionCurveTarget_Model;
            break;
          case TargetNameParameter:
            curve.type = CubismMotionCurveTarget.CubismMotionCurveTarget_Parameter;
            break;
          case TargetNamePartOpacity:
            curve.type = CubismMotionCurveTarget.CubismMotionCurveTarget_PartOpacity;
            break;
          default:
            CubismLogWarning('Warning : Unable to get segment type from Curve! The number of "CurveCount" may be incorrect!');
        }
        curve.id = json.getMotionCurveId(curveCount);
        curve.baseSegmentIndex = totalSegmentCount;
        const fadeInTime = json.getMotionCurveFadeInTime(curveCount);
        const fadeOutTime = json.getMotionCurveFadeOutTime(curveCount);
        curve.fadeInTime = fadeInTime !== void 0 ? fadeInTime : -1;
        curve.fadeOutTime = fadeOutTime !== void 0 ? fadeOutTime : -1;
        for (let segmentPosition = 0; segmentPosition < json.getMotionCurveSegmentCount(curveCount); ) {
          if (segmentPosition == 0) {
            this._motionData.segments[totalSegmentCount].basePointIndex = totalPointCount;
            this._motionData.points[totalPointCount] = new CubismMotionPoint(json.getMotionCurveSegment(curveCount, segmentPosition), json.getMotionCurveSegment(curveCount, segmentPosition + 1));
            totalPointCount += 1;
            segmentPosition += 2;
          } else {
            this._motionData.segments[totalSegmentCount].basePointIndex = totalPointCount - 1;
          }
          const segment = json.getMotionCurveSegment(curveCount, segmentPosition);
          switch (segment) {
            case CubismMotionSegmentType.CubismMotionSegmentType_Linear: {
              this._motionData.segments[totalSegmentCount].segmentType = CubismMotionSegmentType.CubismMotionSegmentType_Linear;
              this._motionData.segments[totalSegmentCount].evaluate = linearEvaluate;
              this._motionData.points[totalPointCount] = new CubismMotionPoint(json.getMotionCurveSegment(curveCount, segmentPosition + 1), json.getMotionCurveSegment(curveCount, segmentPosition + 2));
              totalPointCount += 1;
              segmentPosition += 3;
              break;
            }
            case CubismMotionSegmentType.CubismMotionSegmentType_Bezier: {
              this._motionData.segments[totalSegmentCount].segmentType = CubismMotionSegmentType.CubismMotionSegmentType_Bezier;
              if (areBeziersRestructed || UseOldBeziersCurveMotion) {
                this._motionData.segments[totalSegmentCount].evaluate = bezierEvaluate;
              } else {
                this._motionData.segments[totalSegmentCount].evaluate = bezierEvaluateCardanoInterpretation;
              }
              this._motionData.points[totalPointCount] = new CubismMotionPoint(json.getMotionCurveSegment(curveCount, segmentPosition + 1), json.getMotionCurveSegment(curveCount, segmentPosition + 2));
              this._motionData.points[totalPointCount + 1] = new CubismMotionPoint(json.getMotionCurveSegment(curveCount, segmentPosition + 3), json.getMotionCurveSegment(curveCount, segmentPosition + 4));
              this._motionData.points[totalPointCount + 2] = new CubismMotionPoint(json.getMotionCurveSegment(curveCount, segmentPosition + 5), json.getMotionCurveSegment(curveCount, segmentPosition + 6));
              totalPointCount += 3;
              segmentPosition += 7;
              break;
            }
            case CubismMotionSegmentType.CubismMotionSegmentType_Stepped: {
              this._motionData.segments[totalSegmentCount].segmentType = CubismMotionSegmentType.CubismMotionSegmentType_Stepped;
              this._motionData.segments[totalSegmentCount].evaluate = steppedEvaluate;
              this._motionData.points[totalPointCount] = new CubismMotionPoint(json.getMotionCurveSegment(curveCount, segmentPosition + 1), json.getMotionCurveSegment(curveCount, segmentPosition + 2));
              totalPointCount += 1;
              segmentPosition += 3;
              break;
            }
            case CubismMotionSegmentType.CubismMotionSegmentType_InverseStepped: {
              this._motionData.segments[totalSegmentCount].segmentType = CubismMotionSegmentType.CubismMotionSegmentType_InverseStepped;
              this._motionData.segments[totalSegmentCount].evaluate = inverseSteppedEvaluate;
              this._motionData.points[totalPointCount] = new CubismMotionPoint(json.getMotionCurveSegment(curveCount, segmentPosition + 1), json.getMotionCurveSegment(curveCount, segmentPosition + 2));
              totalPointCount += 1;
              segmentPosition += 3;
              break;
            }
          }
          ++curve.segmentCount;
          ++totalSegmentCount;
        }
        this._motionData.curves.push(curve);
      }
      for (let userdatacount = 0; userdatacount < json.getEventCount(); ++userdatacount) {
        this._motionData.events[userdatacount].fireTime = json.getEventTime(userdatacount);
        this._motionData.events[userdatacount].value = json.getEventValue(userdatacount);
      }
      json.release();
    }
    getFiredEvent(beforeCheckTimeSeconds, motionTimeSeconds) {
      this._firedEventValues.length = 0;
      for (let u = 0; u < this._motionData.eventCount; ++u) {
        if (this._motionData.events[u].fireTime > beforeCheckTimeSeconds && this._motionData.events[u].fireTime <= motionTimeSeconds) {
          this._firedEventValues.push(this._motionData.events[u].value);
        }
      }
      return this._firedEventValues;
    }
  };
  var CubismMotionQueueEntry = class {
    constructor() {
      this._autoDelete = false;
      this._available = true;
      this._finished = false;
      this._started = false;
      this._startTimeSeconds = -1;
      this._fadeInStartTimeSeconds = 0;
      this._endTimeSeconds = -1;
      this._stateTimeSeconds = 0;
      this._stateWeight = 0;
      this._lastEventCheckSeconds = 0;
      this._motionQueueEntryHandle = this;
      this._fadeOutSeconds = 0;
      this._isTriggeredFadeOut = false;
    }
    release() {
      if (this._autoDelete && this._motion) {
        this._motion.release();
      }
    }
    setFadeOut(fadeOutSeconds) {
      this._fadeOutSeconds = fadeOutSeconds;
      this._isTriggeredFadeOut = true;
    }
    startFadeOut(fadeOutSeconds, userTimeSeconds) {
      const newEndTimeSeconds = userTimeSeconds + fadeOutSeconds;
      this._isTriggeredFadeOut = true;
      if (this._endTimeSeconds < 0 || newEndTimeSeconds < this._endTimeSeconds) {
        this._endTimeSeconds = newEndTimeSeconds;
      }
    }
    isFinished() {
      return this._finished;
    }
    isStarted() {
      return this._started;
    }
    getStartTime() {
      return this._startTimeSeconds;
    }
    getFadeInStartTime() {
      return this._fadeInStartTimeSeconds;
    }
    getEndTime() {
      return this._endTimeSeconds;
    }
    setStartTime(startTime) {
      this._startTimeSeconds = startTime;
    }
    setFadeInStartTime(startTime) {
      this._fadeInStartTimeSeconds = startTime;
    }
    setEndTime(endTime) {
      this._endTimeSeconds = endTime;
    }
    setIsFinished(f) {
      this._finished = f;
    }
    setIsStarted(f) {
      this._started = f;
    }
    isAvailable() {
      return this._available;
    }
    setIsAvailable(v) {
      this._available = v;
    }
    setState(timeSeconds, weight) {
      this._stateTimeSeconds = timeSeconds;
      this._stateWeight = weight;
    }
    getStateTime() {
      return this._stateTimeSeconds;
    }
    getStateWeight() {
      return this._stateWeight;
    }
    getLastCheckEventSeconds() {
      return this._lastEventCheckSeconds;
    }
    setLastCheckEventSeconds(checkSeconds) {
      this._lastEventCheckSeconds = checkSeconds;
    }
    isTriggeredFadeOut() {
      return this._isTriggeredFadeOut;
    }
    getFadeOutSeconds() {
      return this._fadeOutSeconds;
    }
  };
  var CubismMotionQueueManager = class {
    constructor() {
      this._userTimeSeconds = 0;
      this._eventCustomData = null;
      this._motions = [];
    }
    release() {
      for (let i = 0; i < this._motions.length; ++i) {
        if (this._motions[i]) {
          this._motions[i].release();
        }
      }
      this._motions = void 0;
    }
    startMotion(motion, autoDelete, userTimeSeconds) {
      if (motion == null) {
        return InvalidMotionQueueEntryHandleValue;
      }
      let motionQueueEntry;
      for (let i = 0; i < this._motions.length; ++i) {
        motionQueueEntry = this._motions[i];
        if (motionQueueEntry == null) {
          continue;
        }
        motionQueueEntry.setFadeOut(motionQueueEntry._motion.getFadeOutTime());
      }
      motionQueueEntry = new CubismMotionQueueEntry();
      motionQueueEntry._autoDelete = autoDelete;
      motionQueueEntry._motion = motion;
      this._motions.push(motionQueueEntry);
      return motionQueueEntry._motionQueueEntryHandle;
    }
    isFinished() {
      let i = 0;
      while (i < this._motions.length) {
        const motionQueueEntry = this._motions[i];
        if (motionQueueEntry == null) {
          this._motions.splice(i, 1);
          continue;
        }
        const motion = motionQueueEntry._motion;
        if (motion == null) {
          motionQueueEntry.release();
          this._motions.splice(i, 1);
          continue;
        }
        if (!motionQueueEntry.isFinished()) {
          return false;
        }
        i++;
      }
      return true;
    }
    isFinishedByHandle(motionQueueEntryNumber) {
      for (let i = 0; i < this._motions.length; i++) {
        const motionQueueEntry = this._motions[i];
        if (motionQueueEntry == null) {
          continue;
        }
        if (motionQueueEntry._motionQueueEntryHandle == motionQueueEntryNumber && !motionQueueEntry.isFinished()) {
          return false;
        }
      }
      return true;
    }
    stopAllMotions() {
      for (let i = 0; i < this._motions.length; i++) {
        const motionQueueEntry = this._motions[i];
        if (motionQueueEntry != null) {
          motionQueueEntry.release();
        }
      }
      this._motions = [];
    }
    getCubismMotionQueueEntry(motionQueueEntryNumber) {
      return this._motions.find((entry) => entry != null && entry._motionQueueEntryHandle == motionQueueEntryNumber);
    }
    setEventCallback(callback, customData = null) {
      this._eventCallBack = callback;
      this._eventCustomData = customData;
    }
    doUpdateMotion(model, userTimeSeconds) {
      let updated = false;
      let i = 0;
      while (i < this._motions.length) {
        const motionQueueEntry = this._motions[i];
        if (motionQueueEntry == null) {
          this._motions.splice(i, 1);
          continue;
        }
        const motion = motionQueueEntry._motion;
        if (motion == null) {
          motionQueueEntry.release();
          this._motions.splice(i, 1);
          continue;
        }
        motion.updateParameters(model, motionQueueEntry, userTimeSeconds);
        updated = true;
        const firedList = motion.getFiredEvent(motionQueueEntry.getLastCheckEventSeconds() - motionQueueEntry.getStartTime(), userTimeSeconds - motionQueueEntry.getStartTime());
        for (let i2 = 0; i2 < firedList.length; ++i2) {
          this._eventCallBack(this, firedList[i2], this._eventCustomData);
        }
        motionQueueEntry.setLastCheckEventSeconds(userTimeSeconds);
        if (motionQueueEntry.isFinished()) {
          motionQueueEntry.release();
          this._motions.splice(i, 1);
        } else {
          if (motionQueueEntry.isTriggeredFadeOut()) {
            motionQueueEntry.startFadeOut(motionQueueEntry.getFadeOutSeconds(), userTimeSeconds);
          }
          i++;
        }
      }
      return updated;
    }
  };
  var InvalidMotionQueueEntryHandleValue = -1;
  var CubismPhysicsTargetType = /* @__PURE__ */ ((CubismPhysicsTargetType2) => {
    CubismPhysicsTargetType2[CubismPhysicsTargetType2["CubismPhysicsTargetType_Parameter"] = 0] = "CubismPhysicsTargetType_Parameter";
    return CubismPhysicsTargetType2;
  })(CubismPhysicsTargetType || {});
  var CubismPhysicsSource = /* @__PURE__ */ ((CubismPhysicsSource2) => {
    CubismPhysicsSource2[CubismPhysicsSource2["CubismPhysicsSource_X"] = 0] = "CubismPhysicsSource_X";
    CubismPhysicsSource2[CubismPhysicsSource2["CubismPhysicsSource_Y"] = 1] = "CubismPhysicsSource_Y";
    CubismPhysicsSource2[CubismPhysicsSource2["CubismPhysicsSource_Angle"] = 2] = "CubismPhysicsSource_Angle";
    return CubismPhysicsSource2;
  })(CubismPhysicsSource || {});
  var CubismPhysicsParticle = class {
    constructor() {
      this.initialPosition = new CubismVector2(0, 0);
      this.position = new CubismVector2(0, 0);
      this.lastPosition = new CubismVector2(0, 0);
      this.lastGravity = new CubismVector2(0, 0);
      this.force = new CubismVector2(0, 0);
      this.velocity = new CubismVector2(0, 0);
    }
  };
  var CubismPhysicsSubRig = class {
    constructor() {
      this.normalizationPosition = {};
      this.normalizationAngle = {};
    }
  };
  var CubismPhysicsInput = class {
    constructor() {
      this.source = {};
    }
  };
  var CubismPhysicsOutput = class {
    constructor() {
      this.destination = {};
      this.translationScale = new CubismVector2(0, 0);
    }
  };
  var CubismPhysicsRig = class {
    constructor() {
      this.settings = [];
      this.inputs = [];
      this.outputs = [];
      this.particles = [];
      this.gravity = new CubismVector2(0, 0);
      this.wind = new CubismVector2(0, 0);
    }
  };
  var CubismPhysicsJson = class {
    constructor(json) {
      this._json = json;
    }
    release() {
      this._json = void 0;
    }
    getGravity() {
      const ret = new CubismVector2(0, 0);
      ret.x = this._json.Meta.EffectiveForces.Gravity.X;
      ret.y = this._json.Meta.EffectiveForces.Gravity.Y;
      return ret;
    }
    getWind() {
      const ret = new CubismVector2(0, 0);
      ret.x = this._json.Meta.EffectiveForces.Wind.X;
      ret.y = this._json.Meta.EffectiveForces.Wind.Y;
      return ret;
    }
    getSubRigCount() {
      return this._json.Meta.PhysicsSettingCount;
    }
    getTotalInputCount() {
      return this._json.Meta.TotalInputCount;
    }
    getTotalOutputCount() {
      return this._json.Meta.TotalOutputCount;
    }
    getVertexCount() {
      return this._json.Meta.VertexCount;
    }
    getNormalizationPositionMinimumValue(physicsSettingIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Normalization.Position.Minimum;
    }
    getNormalizationPositionMaximumValue(physicsSettingIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Normalization.Position.Maximum;
    }
    getNormalizationPositionDefaultValue(physicsSettingIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Normalization.Position.Default;
    }
    getNormalizationAngleMinimumValue(physicsSettingIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Normalization.Angle.Minimum;
    }
    getNormalizationAngleMaximumValue(physicsSettingIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Normalization.Angle.Maximum;
    }
    getNormalizationAngleDefaultValue(physicsSettingIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Normalization.Angle.Default;
    }
    getInputCount(physicsSettingIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Input.length;
    }
    getInputWeight(physicsSettingIndex, inputIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Input[inputIndex].Weight;
    }
    getInputReflect(physicsSettingIndex, inputIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Input[inputIndex].Reflect;
    }
    getInputType(physicsSettingIndex, inputIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Input[inputIndex].Type;
    }
    getInputSourceId(physicsSettingIndex, inputIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Input[inputIndex].Source.Id;
    }
    getOutputCount(physicsSettingIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Output.length;
    }
    getOutputVertexIndex(physicsSettingIndex, outputIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Output[outputIndex].VertexIndex;
    }
    getOutputAngleScale(physicsSettingIndex, outputIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Output[outputIndex].Scale;
    }
    getOutputWeight(physicsSettingIndex, outputIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Output[outputIndex].Weight;
    }
    getOutputDestinationId(physicsSettingIndex, outputIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Output[outputIndex].Destination.Id;
    }
    getOutputType(physicsSettingIndex, outputIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Output[outputIndex].Type;
    }
    getOutputReflect(physicsSettingIndex, outputIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Output[outputIndex].Reflect;
    }
    getParticleCount(physicsSettingIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Vertices.length;
    }
    getParticleMobility(physicsSettingIndex, vertexIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Vertices[vertexIndex].Mobility;
    }
    getParticleDelay(physicsSettingIndex, vertexIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Vertices[vertexIndex].Delay;
    }
    getParticleAcceleration(physicsSettingIndex, vertexIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Vertices[vertexIndex].Acceleration;
    }
    getParticleRadius(physicsSettingIndex, vertexIndex) {
      return this._json.PhysicsSettings[physicsSettingIndex].Vertices[vertexIndex].Radius;
    }
    getParticlePosition(physicsSettingIndex, vertexIndex) {
      const ret = new CubismVector2(0, 0);
      ret.x = this._json.PhysicsSettings[physicsSettingIndex].Vertices[vertexIndex].Position.X;
      ret.y = this._json.PhysicsSettings[physicsSettingIndex].Vertices[vertexIndex].Position.Y;
      return ret;
    }
  };
  var PhysicsTypeTagX = "X";
  var PhysicsTypeTagY = "Y";
  var PhysicsTypeTagAngle = "Angle";
  var AirResistance = 5;
  var MaximumWeight = 100;
  var MovementThreshold = 1e-3;
  var CubismPhysics = class _CubismPhysics {
    static create(json) {
      const ret = new _CubismPhysics();
      ret.parse(json);
      ret._physicsRig.gravity.y = 0;
      return ret;
    }
    evaluate(model, deltaTimeSeconds) {
      let totalAngle;
      let weight;
      let radAngle;
      let outputValue;
      const totalTranslation = new CubismVector2();
      let currentSetting;
      let currentInput;
      let currentOutput;
      let currentParticles;
      let parameterValue;
      let parameterMaximumValue;
      let parameterMinimumValue;
      let parameterDefaultValue;
      parameterValue = model.getModel().parameters.values;
      parameterMaximumValue = model.getModel().parameters.maximumValues;
      parameterMinimumValue = model.getModel().parameters.minimumValues;
      parameterDefaultValue = model.getModel().parameters.defaultValues;
      for (let settingIndex = 0; settingIndex < this._physicsRig.subRigCount; ++settingIndex) {
        totalAngle = { angle: 0 };
        totalTranslation.x = 0;
        totalTranslation.y = 0;
        currentSetting = this._physicsRig.settings[settingIndex];
        currentInput = this._physicsRig.inputs.slice(currentSetting.baseInputIndex);
        currentOutput = this._physicsRig.outputs.slice(currentSetting.baseOutputIndex);
        currentParticles = this._physicsRig.particles.slice(currentSetting.baseParticleIndex);
        for (let i = 0; i < currentSetting.inputCount; ++i) {
          weight = currentInput[i].weight / MaximumWeight;
          if (currentInput[i].sourceParameterIndex == -1) {
            currentInput[i].sourceParameterIndex = model.getParameterIndex(currentInput[i].source.id);
          }
          currentInput[i].getNormalizedParameterValue(totalTranslation, totalAngle, parameterValue[currentInput[i].sourceParameterIndex], parameterMinimumValue[currentInput[i].sourceParameterIndex], parameterMaximumValue[currentInput[i].sourceParameterIndex], parameterDefaultValue[currentInput[i].sourceParameterIndex], currentSetting.normalizationPosition, currentSetting.normalizationAngle, currentInput[i].reflect, weight);
        }
        radAngle = CubismMath.degreesToRadian(-totalAngle.angle);
        totalTranslation.x = totalTranslation.x * CubismMath.cos(radAngle) - totalTranslation.y * CubismMath.sin(radAngle);
        totalTranslation.y = totalTranslation.x * CubismMath.sin(radAngle) + totalTranslation.y * CubismMath.cos(radAngle);
        updateParticles(currentParticles, currentSetting.particleCount, totalTranslation, totalAngle.angle, this._options.wind, MovementThreshold * currentSetting.normalizationPosition.maximum, deltaTimeSeconds, AirResistance);
        for (let i = 0; i < currentSetting.outputCount; ++i) {
          const particleIndex = currentOutput[i].vertexIndex;
          if (particleIndex < 1 || particleIndex >= currentSetting.particleCount) {
            break;
          }
          if (currentOutput[i].destinationParameterIndex == -1) {
            currentOutput[i].destinationParameterIndex = model.getParameterIndex(currentOutput[i].destination.id);
          }
          const translation = new CubismVector2();
          translation.x = currentParticles[particleIndex].position.x - currentParticles[particleIndex - 1].position.x;
          translation.y = currentParticles[particleIndex].position.y - currentParticles[particleIndex - 1].position.y;
          outputValue = currentOutput[i].getValue(translation, currentParticles, particleIndex, currentOutput[i].reflect, this._options.gravity);
          const destinationParameterIndex = currentOutput[i].destinationParameterIndex;
          const outParameterValue = !Float32Array.prototype.slice && "subarray" in Float32Array.prototype ? JSON.parse(JSON.stringify(parameterValue.subarray(destinationParameterIndex))) : parameterValue.slice(destinationParameterIndex);
          updateOutputParameterValue(outParameterValue, parameterMinimumValue[destinationParameterIndex], parameterMaximumValue[destinationParameterIndex], outputValue, currentOutput[i]);
          for (let offset = destinationParameterIndex, outParamIndex = 0; offset < parameterValue.length; offset++, outParamIndex++) {
            parameterValue[offset] = outParameterValue[outParamIndex];
          }
        }
      }
    }
    setOptions(options) {
      this._options = options;
    }
    getOption() {
      return this._options;
    }
    constructor() {
      this._options = new Options();
      this._options.gravity.y = -1;
      this._options.gravity.x = 0;
      this._options.wind.x = 0;
      this._options.wind.y = 0;
    }
    release() {
      this._physicsRig = void 0;
    }
    parse(physicsJson) {
      this._physicsRig = new CubismPhysicsRig();
      let json = new CubismPhysicsJson(physicsJson);
      this._physicsRig.gravity = json.getGravity();
      this._physicsRig.wind = json.getWind();
      this._physicsRig.subRigCount = json.getSubRigCount();
      let inputIndex = 0, outputIndex = 0, particleIndex = 0;
      for (let i = 0; i < this._physicsRig.subRigCount; ++i) {
        const setting = new CubismPhysicsSubRig();
        setting.normalizationPosition.minimum = json.getNormalizationPositionMinimumValue(i);
        setting.normalizationPosition.maximum = json.getNormalizationPositionMaximumValue(i);
        setting.normalizationPosition.defalut = json.getNormalizationPositionDefaultValue(i);
        setting.normalizationAngle.minimum = json.getNormalizationAngleMinimumValue(i);
        setting.normalizationAngle.maximum = json.getNormalizationAngleMaximumValue(i);
        setting.normalizationAngle.defalut = json.getNormalizationAngleDefaultValue(i);
        setting.inputCount = json.getInputCount(i);
        setting.baseInputIndex = inputIndex;
        inputIndex += setting.inputCount;
        for (let j = 0; j < setting.inputCount; ++j) {
          const input = new CubismPhysicsInput();
          input.sourceParameterIndex = -1;
          input.weight = json.getInputWeight(i, j);
          input.reflect = json.getInputReflect(i, j);
          switch (json.getInputType(i, j)) {
            case PhysicsTypeTagX:
              input.type = CubismPhysicsSource.CubismPhysicsSource_X;
              input.getNormalizedParameterValue = getInputTranslationXFromNormalizedParameterValue;
              break;
            case PhysicsTypeTagY:
              input.type = CubismPhysicsSource.CubismPhysicsSource_Y;
              input.getNormalizedParameterValue = getInputTranslationYFromNormalizedParamterValue;
              break;
            case PhysicsTypeTagAngle:
              input.type = CubismPhysicsSource.CubismPhysicsSource_Angle;
              input.getNormalizedParameterValue = getInputAngleFromNormalizedParameterValue;
              break;
          }
          input.source.targetType = CubismPhysicsTargetType.CubismPhysicsTargetType_Parameter;
          input.source.id = json.getInputSourceId(i, j);
          this._physicsRig.inputs.push(input);
        }
        setting.outputCount = json.getOutputCount(i);
        setting.baseOutputIndex = outputIndex;
        outputIndex += setting.outputCount;
        for (let j = 0; j < setting.outputCount; ++j) {
          const output = new CubismPhysicsOutput();
          output.destinationParameterIndex = -1;
          output.vertexIndex = json.getOutputVertexIndex(i, j);
          output.angleScale = json.getOutputAngleScale(i, j);
          output.weight = json.getOutputWeight(i, j);
          output.destination.targetType = CubismPhysicsTargetType.CubismPhysicsTargetType_Parameter;
          output.destination.id = json.getOutputDestinationId(i, j);
          switch (json.getOutputType(i, j)) {
            case PhysicsTypeTagX:
              output.type = CubismPhysicsSource.CubismPhysicsSource_X;
              output.getValue = getOutputTranslationX;
              output.getScale = getOutputScaleTranslationX;
              break;
            case PhysicsTypeTagY:
              output.type = CubismPhysicsSource.CubismPhysicsSource_Y;
              output.getValue = getOutputTranslationY;
              output.getScale = getOutputScaleTranslationY;
              break;
            case PhysicsTypeTagAngle:
              output.type = CubismPhysicsSource.CubismPhysicsSource_Angle;
              output.getValue = getOutputAngle;
              output.getScale = getOutputScaleAngle;
              break;
          }
          output.reflect = json.getOutputReflect(i, j);
          this._physicsRig.outputs.push(output);
        }
        setting.particleCount = json.getParticleCount(i);
        setting.baseParticleIndex = particleIndex;
        particleIndex += setting.particleCount;
        for (let j = 0; j < setting.particleCount; ++j) {
          const particle = new CubismPhysicsParticle();
          particle.mobility = json.getParticleMobility(i, j);
          particle.delay = json.getParticleDelay(i, j);
          particle.acceleration = json.getParticleAcceleration(i, j);
          particle.radius = json.getParticleRadius(i, j);
          particle.position = json.getParticlePosition(i, j);
          this._physicsRig.particles.push(particle);
        }
        this._physicsRig.settings.push(setting);
      }
      this.initialize();
      json.release();
    }
    initialize() {
      let strand;
      let currentSetting;
      let radius;
      for (let settingIndex = 0; settingIndex < this._physicsRig.subRigCount; ++settingIndex) {
        currentSetting = this._physicsRig.settings[settingIndex];
        strand = this._physicsRig.particles.slice(currentSetting.baseParticleIndex);
        strand[0].initialPosition = new CubismVector2(0, 0);
        strand[0].lastPosition = new CubismVector2(strand[0].initialPosition.x, strand[0].initialPosition.y);
        strand[0].lastGravity = new CubismVector2(0, -1);
        strand[0].lastGravity.y *= -1;
        strand[0].velocity = new CubismVector2(0, 0);
        strand[0].force = new CubismVector2(0, 0);
        for (let i = 1; i < currentSetting.particleCount; ++i) {
          radius = new CubismVector2(0, 0);
          radius.y = strand[i].radius;
          strand[i].initialPosition = new CubismVector2(strand[i - 1].initialPosition.x + radius.x, strand[i - 1].initialPosition.y + radius.y);
          strand[i].position = new CubismVector2(strand[i].initialPosition.x, strand[i].initialPosition.y);
          strand[i].lastPosition = new CubismVector2(strand[i].initialPosition.x, strand[i].initialPosition.y);
          strand[i].lastGravity = new CubismVector2(0, -1);
          strand[i].lastGravity.y *= -1;
          strand[i].velocity = new CubismVector2(0, 0);
          strand[i].force = new CubismVector2(0, 0);
        }
      }
    }
  };
  var Options = class {
    constructor() {
      this.gravity = new CubismVector2(0, 0);
      this.wind = new CubismVector2(0, 0);
    }
  };
  function getInputTranslationXFromNormalizedParameterValue(targetTranslation, targetAngle, value, parameterMinimumValue, parameterMaximumValue, parameterDefaultValue, normalizationPosition, normalizationAngle, isInverted, weight) {
    targetTranslation.x += normalizeParameterValue(value, parameterMinimumValue, parameterMaximumValue, parameterDefaultValue, normalizationPosition.minimum, normalizationPosition.maximum, normalizationPosition.defalut, isInverted) * weight;
  }
  function getInputTranslationYFromNormalizedParamterValue(targetTranslation, targetAngle, value, parameterMinimumValue, parameterMaximumValue, parameterDefaultValue, normalizationPosition, normalizationAngle, isInverted, weight) {
    targetTranslation.y += normalizeParameterValue(value, parameterMinimumValue, parameterMaximumValue, parameterDefaultValue, normalizationPosition.minimum, normalizationPosition.maximum, normalizationPosition.defalut, isInverted) * weight;
  }
  function getInputAngleFromNormalizedParameterValue(targetTranslation, targetAngle, value, parameterMinimumValue, parameterMaximumValue, parameterDefaultValue, normalizaitionPosition, normalizationAngle, isInverted, weight) {
    targetAngle.angle += normalizeParameterValue(value, parameterMinimumValue, parameterMaximumValue, parameterDefaultValue, normalizationAngle.minimum, normalizationAngle.maximum, normalizationAngle.defalut, isInverted) * weight;
  }
  function getOutputTranslationX(translation, particles, particleIndex, isInverted, parentGravity) {
    let outputValue = translation.x;
    if (isInverted) {
      outputValue *= -1;
    }
    return outputValue;
  }
  function getOutputTranslationY(translation, particles, particleIndex, isInverted, parentGravity) {
    let outputValue = translation.y;
    if (isInverted) {
      outputValue *= -1;
    }
    return outputValue;
  }
  function getOutputAngle(translation, particles, particleIndex, isInverted, parentGravity) {
    let outputValue;
    if (particleIndex >= 2) {
      parentGravity = particles[particleIndex - 1].position.substract(particles[particleIndex - 2].position);
    } else {
      parentGravity = parentGravity.multiplyByScaler(-1);
    }
    outputValue = CubismMath.directionToRadian(parentGravity, translation);
    if (isInverted) {
      outputValue *= -1;
    }
    return outputValue;
  }
  function getRangeValue(min, max) {
    return Math.abs(Math.max(min, max) - Math.min(min, max));
  }
  function getDefaultValue(min, max) {
    const minValue = Math.min(min, max);
    return minValue + getRangeValue(min, max) / 2;
  }
  function getOutputScaleTranslationX(translationScale, angleScale) {
    return translationScale.x;
  }
  function getOutputScaleTranslationY(translationScale, angleScale) {
    return translationScale.y;
  }
  function getOutputScaleAngle(translationScale, angleScale) {
    return angleScale;
  }
  function updateParticles(strand, strandCount, totalTranslation, totalAngle, windDirection, thresholdValue, deltaTimeSeconds, airResistance) {
    let totalRadian;
    let delay;
    let radian;
    let currentGravity;
    let direction = new CubismVector2(0, 0);
    let velocity = new CubismVector2(0, 0);
    let force = new CubismVector2(0, 0);
    let newDirection = new CubismVector2(0, 0);
    strand[0].position = new CubismVector2(totalTranslation.x, totalTranslation.y);
    totalRadian = CubismMath.degreesToRadian(totalAngle);
    currentGravity = CubismMath.radianToDirection(totalRadian);
    currentGravity.normalize();
    for (let i = 1; i < strandCount; ++i) {
      strand[i].force = currentGravity.multiplyByScaler(strand[i].acceleration).add(windDirection);
      strand[i].lastPosition = new CubismVector2(strand[i].position.x, strand[i].position.y);
      delay = strand[i].delay * deltaTimeSeconds * 30;
      direction = strand[i].position.substract(strand[i - 1].position);
      radian = CubismMath.directionToRadian(strand[i].lastGravity, currentGravity) / airResistance;
      direction.x = CubismMath.cos(radian) * direction.x - direction.y * CubismMath.sin(radian);
      direction.y = CubismMath.sin(radian) * direction.x + direction.y * CubismMath.cos(radian);
      strand[i].position = strand[i - 1].position.add(direction);
      velocity = strand[i].velocity.multiplyByScaler(delay);
      force = strand[i].force.multiplyByScaler(delay).multiplyByScaler(delay);
      strand[i].position = strand[i].position.add(velocity).add(force);
      newDirection = strand[i].position.substract(strand[i - 1].position);
      newDirection.normalize();
      strand[i].position = strand[i - 1].position.add(newDirection.multiplyByScaler(strand[i].radius));
      if (CubismMath.abs(strand[i].position.x) < thresholdValue) {
        strand[i].position.x = 0;
      }
      if (delay != 0) {
        strand[i].velocity = strand[i].position.substract(strand[i].lastPosition);
        strand[i].velocity = strand[i].velocity.divisionByScalar(delay);
        strand[i].velocity = strand[i].velocity.multiplyByScaler(strand[i].mobility);
      }
      strand[i].force = new CubismVector2(0, 0);
      strand[i].lastGravity = new CubismVector2(currentGravity.x, currentGravity.y);
    }
  }
  function updateOutputParameterValue(parameterValue, parameterValueMinimum, parameterValueMaximum, translation, output) {
    let outputScale;
    let value;
    let weight;
    outputScale = output.getScale(output.translationScale, output.angleScale);
    value = translation * outputScale;
    if (value < parameterValueMinimum) {
      if (value < output.valueBelowMinimum) {
        output.valueBelowMinimum = value;
      }
      value = parameterValueMinimum;
    } else if (value > parameterValueMaximum) {
      if (value > output.valueExceededMaximum) {
        output.valueExceededMaximum = value;
      }
      value = parameterValueMaximum;
    }
    weight = output.weight / MaximumWeight;
    if (weight >= 1) {
      parameterValue[0] = value;
    } else {
      value = parameterValue[0] * (1 - weight) + value * weight;
      parameterValue[0] = value;
    }
  }
  function normalizeParameterValue(value, parameterMinimum, parameterMaximum, parameterDefault, normalizedMinimum, normalizedMaximum, normalizedDefault, isInverted) {
    let result = 0;
    const maxValue = CubismMath.max(parameterMaximum, parameterMinimum);
    if (maxValue < value) {
      value = maxValue;
    }
    const minValue = CubismMath.min(parameterMaximum, parameterMinimum);
    if (minValue > value) {
      value = minValue;
    }
    const minNormValue = CubismMath.min(normalizedMinimum, normalizedMaximum);
    const maxNormValue = CubismMath.max(normalizedMinimum, normalizedMaximum);
    const middleNormValue = normalizedDefault;
    const middleValue = getDefaultValue(minValue, maxValue);
    const paramValue = value - middleValue;
    switch (Math.sign(paramValue)) {
      case 1: {
        const nLength = maxNormValue - middleNormValue;
        const pLength = maxValue - middleValue;
        if (pLength != 0) {
          result = paramValue * (nLength / pLength);
          result += middleNormValue;
        }
        break;
      }
      case -1: {
        const nLength = minNormValue - middleNormValue;
        const pLength = minValue - middleValue;
        if (pLength != 0) {
          result = paramValue * (nLength / pLength);
          result += middleNormValue;
        }
        break;
      }
      case 0: {
        result = middleNormValue;
        break;
      }
    }
    return isInverted ? result : result * -1;
  }
  var csmRect = class {
    constructor(x = 0, y = 0, w = 0, h = 0) {
      this.x = x;
      this.y = y;
      this.width = w;
      this.height = h;
    }
    getCenterX() {
      return this.x + 0.5 * this.width;
    }
    getCenterY() {
      return this.y + 0.5 * this.height;
    }
    getRight() {
      return this.x + this.width;
    }
    getBottom() {
      return this.y + this.height;
    }
    setRect(r) {
      this.x = r.x;
      this.y = r.y;
      this.width = r.width;
      this.height = r.height;
    }
    expand(w, h) {
      this.x -= w;
      this.y -= h;
      this.width += w * 2;
      this.height += h * 2;
    }
  };
  var ColorChannelCount = 4;
  var shaderCount = 10;
  var s_instance;
  var s_viewport;
  var s_fbo;
  var CubismClippingManager_WebGL = class {
    getChannelFlagAsColor(channelNo) {
      return this._channelColors[channelNo];
    }
    getMaskRenderTexture() {
      let ret = 0;
      if (this._maskTexture && this._maskTexture.texture != 0) {
        this._maskTexture.frameNo = this._currentFrameNo;
        ret = this._maskTexture.texture;
      }
      if (ret == 0) {
        const size = this._clippingMaskBufferSize;
        this._colorBuffer = this.gl.createTexture();
        this.gl.bindTexture(this.gl.TEXTURE_2D, this._colorBuffer);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, size, size, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, null);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
        this.gl.bindTexture(this.gl.TEXTURE_2D, null);
        ret = this.gl.createFramebuffer();
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, ret);
        this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, this._colorBuffer, 0);
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, s_fbo);
        this._maskTexture = new CubismRenderTextureResource(this._currentFrameNo, ret);
      }
      return ret;
    }
    setGL(gl) {
      this.gl = gl;
    }
    calcClippedDrawTotalBounds(model, clippingContext) {
      let clippedDrawTotalMinX = Number.MAX_VALUE;
      let clippedDrawTotalMinY = Number.MAX_VALUE;
      let clippedDrawTotalMaxX = Number.MIN_VALUE;
      let clippedDrawTotalMaxY = Number.MIN_VALUE;
      const clippedDrawCount = clippingContext._clippedDrawableIndexList.length;
      for (let clippedDrawableIndex = 0; clippedDrawableIndex < clippedDrawCount; clippedDrawableIndex++) {
        const drawableIndex = clippingContext._clippedDrawableIndexList[clippedDrawableIndex];
        const drawableVertexCount = model.getDrawableVertexCount(drawableIndex);
        const drawableVertexes = model.getDrawableVertices(drawableIndex);
        let minX = Number.MAX_VALUE;
        let minY = Number.MAX_VALUE;
        let maxX = Number.MIN_VALUE;
        let maxY = Number.MIN_VALUE;
        const loop = drawableVertexCount * Constant.vertexStep;
        for (let pi = Constant.vertexOffset; pi < loop; pi += Constant.vertexStep) {
          const x = drawableVertexes[pi];
          const y = drawableVertexes[pi + 1];
          if (x < minX) {
            minX = x;
          }
          if (x > maxX) {
            maxX = x;
          }
          if (y < minY) {
            minY = y;
          }
          if (y > maxY) {
            maxY = y;
          }
        }
        if (minX == Number.MAX_VALUE) {
          continue;
        }
        if (minX < clippedDrawTotalMinX) {
          clippedDrawTotalMinX = minX;
        }
        if (minY < clippedDrawTotalMinY) {
          clippedDrawTotalMinY = minY;
        }
        if (maxX > clippedDrawTotalMaxX) {
          clippedDrawTotalMaxX = maxX;
        }
        if (maxY > clippedDrawTotalMaxY) {
          clippedDrawTotalMaxY = maxY;
        }
        if (clippedDrawTotalMinX == Number.MAX_VALUE) {
          clippingContext._allClippedDrawRect.x = 0;
          clippingContext._allClippedDrawRect.y = 0;
          clippingContext._allClippedDrawRect.width = 0;
          clippingContext._allClippedDrawRect.height = 0;
          clippingContext._isUsing = false;
        } else {
          clippingContext._isUsing = true;
          const w = clippedDrawTotalMaxX - clippedDrawTotalMinX;
          const h = clippedDrawTotalMaxY - clippedDrawTotalMinY;
          clippingContext._allClippedDrawRect.x = clippedDrawTotalMinX;
          clippingContext._allClippedDrawRect.y = clippedDrawTotalMinY;
          clippingContext._allClippedDrawRect.width = w;
          clippingContext._allClippedDrawRect.height = h;
        }
      }
    }
    constructor() {
      this._maskRenderTexture = null;
      this._colorBuffer = null;
      this._currentFrameNo = 0;
      this._clippingMaskBufferSize = 256;
      this._clippingContextListForMask = [];
      this._clippingContextListForDraw = [];
      this._channelColors = [];
      this._tmpBoundsOnModel = new csmRect();
      this._tmpMatrix = new CubismMatrix44();
      this._tmpMatrixForMask = new CubismMatrix44();
      this._tmpMatrixForDraw = new CubismMatrix44();
      let tmp = new CubismTextureColor();
      tmp.R = 1;
      tmp.G = 0;
      tmp.B = 0;
      tmp.A = 0;
      this._channelColors.push(tmp);
      tmp = new CubismTextureColor();
      tmp.R = 0;
      tmp.G = 1;
      tmp.B = 0;
      tmp.A = 0;
      this._channelColors.push(tmp);
      tmp = new CubismTextureColor();
      tmp.R = 0;
      tmp.G = 0;
      tmp.B = 1;
      tmp.A = 0;
      this._channelColors.push(tmp);
      tmp = new CubismTextureColor();
      tmp.R = 0;
      tmp.G = 0;
      tmp.B = 0;
      tmp.A = 1;
      this._channelColors.push(tmp);
    }
    release() {
      var _a, _b, _c;
      const self2 = this;
      for (let i = 0; i < this._clippingContextListForMask.length; i++) {
        if (this._clippingContextListForMask[i]) {
          (_a = this._clippingContextListForMask[i]) == null ? void 0 : _a.release();
        }
      }
      self2._clippingContextListForMask = void 0;
      self2._clippingContextListForDraw = void 0;
      if (this._maskTexture) {
        (_b = this.gl) == null ? void 0 : _b.deleteFramebuffer(this._maskTexture.texture);
        self2._maskTexture = void 0;
      }
      self2._channelColors = void 0;
      (_c = this.gl) == null ? void 0 : _c.deleteTexture(this._colorBuffer);
      this._colorBuffer = null;
    }
    initialize(model, drawableCount, drawableMasks, drawableMaskCounts) {
      for (let i = 0; i < drawableCount; i++) {
        if (drawableMaskCounts[i] <= 0) {
          this._clippingContextListForDraw.push(null);
          continue;
        }
        let clippingContext = this.findSameClip(drawableMasks[i], drawableMaskCounts[i]);
        if (clippingContext == null) {
          clippingContext = new CubismClippingContext(this, drawableMasks[i], drawableMaskCounts[i]);
          this._clippingContextListForMask.push(clippingContext);
        }
        clippingContext.addClippedDrawable(i);
        this._clippingContextListForDraw.push(clippingContext);
      }
    }
    setupClippingContext(model, renderer) {
      this._currentFrameNo++;
      let usingClipCount = 0;
      for (let clipIndex = 0; clipIndex < this._clippingContextListForMask.length; clipIndex++) {
        const cc = this._clippingContextListForMask[clipIndex];
        this.calcClippedDrawTotalBounds(model, cc);
        if (cc._isUsing) {
          usingClipCount++;
        }
      }
      if (usingClipCount > 0) {
        this.gl.viewport(0, 0, this._clippingMaskBufferSize, this._clippingMaskBufferSize);
        this._maskRenderTexture = this.getMaskRenderTexture();
        renderer.getMvpMatrix();
        renderer.preDraw();
        this.setupLayoutBounds(usingClipCount);
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this._maskRenderTexture);
        this.gl.clearColor(1, 1, 1, 1);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        for (let clipIndex = 0; clipIndex < this._clippingContextListForMask.length; clipIndex++) {
          const clipContext = this._clippingContextListForMask[clipIndex];
          const allClipedDrawRect = clipContext._allClippedDrawRect;
          const layoutBoundsOnTex01 = clipContext._layoutBounds;
          const MARGIN = 0.05;
          this._tmpBoundsOnModel.setRect(allClipedDrawRect);
          this._tmpBoundsOnModel.expand(allClipedDrawRect.width * MARGIN, allClipedDrawRect.height * MARGIN);
          const scaleX = layoutBoundsOnTex01.width / this._tmpBoundsOnModel.width;
          const scaleY = layoutBoundsOnTex01.height / this._tmpBoundsOnModel.height;
          {
            this._tmpMatrix.loadIdentity();
            {
              this._tmpMatrix.translateRelative(-1, -1);
              this._tmpMatrix.scaleRelative(2, 2);
            }
            {
              this._tmpMatrix.translateRelative(layoutBoundsOnTex01.x, layoutBoundsOnTex01.y);
              this._tmpMatrix.scaleRelative(scaleX, scaleY);
              this._tmpMatrix.translateRelative(-this._tmpBoundsOnModel.x, -this._tmpBoundsOnModel.y);
            }
            this._tmpMatrixForMask.setMatrix(this._tmpMatrix.getArray());
          }
          {
            this._tmpMatrix.loadIdentity();
            {
              this._tmpMatrix.translateRelative(layoutBoundsOnTex01.x, layoutBoundsOnTex01.y);
              this._tmpMatrix.scaleRelative(scaleX, scaleY);
              this._tmpMatrix.translateRelative(-this._tmpBoundsOnModel.x, -this._tmpBoundsOnModel.y);
            }
            this._tmpMatrixForDraw.setMatrix(this._tmpMatrix.getArray());
          }
          clipContext._matrixForMask.setMatrix(this._tmpMatrixForMask.getArray());
          clipContext._matrixForDraw.setMatrix(this._tmpMatrixForDraw.getArray());
          const clipDrawCount = clipContext._clippingIdCount;
          for (let i = 0; i < clipDrawCount; i++) {
            const clipDrawIndex = clipContext._clippingIdList[i];
            if (!model.getDrawableDynamicFlagVertexPositionsDidChange(clipDrawIndex)) {
              continue;
            }
            renderer.setIsCulling(model.getDrawableCulling(clipDrawIndex) != false);
            renderer.setClippingContextBufferForMask(clipContext);
            renderer.drawMesh(model.getDrawableTextureIndices(clipDrawIndex), model.getDrawableVertexIndexCount(clipDrawIndex), model.getDrawableVertexCount(clipDrawIndex), model.getDrawableVertexIndices(clipDrawIndex), model.getDrawableVertices(clipDrawIndex), model.getDrawableVertexUvs(clipDrawIndex), model.getDrawableOpacity(clipDrawIndex), CubismBlendMode.CubismBlendMode_Normal, false);
          }
        }
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, s_fbo);
        renderer.setClippingContextBufferForMask(null);
        this.gl.viewport(s_viewport[0], s_viewport[1], s_viewport[2], s_viewport[3]);
      }
    }
    findSameClip(drawableMasks, drawableMaskCounts) {
      for (let i = 0; i < this._clippingContextListForMask.length; i++) {
        const clippingContext = this._clippingContextListForMask[i];
        const count = clippingContext._clippingIdCount;
        if (count != drawableMaskCounts) {
          continue;
        }
        let sameCount = 0;
        for (let j = 0; j < count; j++) {
          const clipId = clippingContext._clippingIdList[j];
          for (let k = 0; k < count; k++) {
            if (drawableMasks[k] == clipId) {
              sameCount++;
              break;
            }
          }
        }
        if (sameCount == count) {
          return clippingContext;
        }
      }
      return null;
    }
    setupLayoutBounds(usingClipCount) {
      let div = usingClipCount / ColorChannelCount;
      let mod = usingClipCount % ColorChannelCount;
      div = ~~div;
      mod = ~~mod;
      let curClipIndex = 0;
      for (let channelNo = 0; channelNo < ColorChannelCount; channelNo++) {
        const layoutCount = div + (channelNo < mod ? 1 : 0);
        if (layoutCount == 0)
          ;
        else if (layoutCount == 1) {
          const clipContext = this._clippingContextListForMask[curClipIndex++];
          clipContext._layoutChannelNo = channelNo;
          clipContext._layoutBounds.x = 0;
          clipContext._layoutBounds.y = 0;
          clipContext._layoutBounds.width = 1;
          clipContext._layoutBounds.height = 1;
        } else if (layoutCount == 2) {
          for (let i = 0; i < layoutCount; i++) {
            let xpos = i % 2;
            xpos = ~~xpos;
            const cc = this._clippingContextListForMask[curClipIndex++];
            cc._layoutChannelNo = channelNo;
            cc._layoutBounds.x = xpos * 0.5;
            cc._layoutBounds.y = 0;
            cc._layoutBounds.width = 0.5;
            cc._layoutBounds.height = 1;
          }
        } else if (layoutCount <= 4) {
          for (let i = 0; i < layoutCount; i++) {
            let xpos = i % 2;
            let ypos = i / 2;
            xpos = ~~xpos;
            ypos = ~~ypos;
            const cc = this._clippingContextListForMask[curClipIndex++];
            cc._layoutChannelNo = channelNo;
            cc._layoutBounds.x = xpos * 0.5;
            cc._layoutBounds.y = ypos * 0.5;
            cc._layoutBounds.width = 0.5;
            cc._layoutBounds.height = 0.5;
          }
        } else if (layoutCount <= 9) {
          for (let i = 0; i < layoutCount; i++) {
            let xpos = i % 3;
            let ypos = i / 3;
            xpos = ~~xpos;
            ypos = ~~ypos;
            const cc = this._clippingContextListForMask[curClipIndex++];
            cc._layoutChannelNo = channelNo;
            cc._layoutBounds.x = xpos / 3;
            cc._layoutBounds.y = ypos / 3;
            cc._layoutBounds.width = 1 / 3;
            cc._layoutBounds.height = 1 / 3;
          }
        } else if (CubismConfig.supportMoreMaskDivisions && layoutCount <= 16) {
          for (let i = 0; i < layoutCount; i++) {
            let xpos = i % 4;
            let ypos = i / 4;
            xpos = ~~xpos;
            ypos = ~~ypos;
            const cc = this._clippingContextListForMask[curClipIndex++];
            cc._layoutChannelNo = channelNo;
            cc._layoutBounds.x = xpos / 4;
            cc._layoutBounds.y = ypos / 4;
            cc._layoutBounds.width = 1 / 4;
            cc._layoutBounds.height = 1 / 4;
          }
        } else {
          CubismLogError("not supported mask count : {0}", layoutCount);
        }
      }
    }
    getColorBuffer() {
      return this._colorBuffer;
    }
    getClippingContextListForDraw() {
      return this._clippingContextListForDraw;
    }
    setClippingMaskBufferSize(size) {
      this._clippingMaskBufferSize = size;
    }
    getClippingMaskBufferSize() {
      return this._clippingMaskBufferSize;
    }
  };
  var CubismRenderTextureResource = class {
    constructor(frameNo, texture) {
      this.frameNo = frameNo;
      this.texture = texture;
    }
  };
  var CubismClippingContext = class {
    constructor(manager, clippingDrawableIndices, clipCount) {
      this._isUsing = false;
      this._owner = manager;
      this._clippingIdList = clippingDrawableIndices;
      this._clippingIdCount = clipCount;
      this._allClippedDrawRect = new csmRect();
      this._layoutBounds = new csmRect();
      this._clippedDrawableIndexList = [];
      this._matrixForMask = new CubismMatrix44();
      this._matrixForDraw = new CubismMatrix44();
    }
    release() {
      const self2 = this;
      self2._layoutBounds = void 0;
      self2._allClippedDrawRect = void 0;
      self2._clippedDrawableIndexList = void 0;
    }
    addClippedDrawable(drawableIndex) {
      this._clippedDrawableIndexList.push(drawableIndex);
    }
    getClippingManager() {
      return this._owner;
    }
    setGl(gl) {
      this._owner.setGL(gl);
    }
  };
  var CubismShader_WebGL = class _CubismShader_WebGL {
    static getInstance() {
      if (s_instance == null) {
        s_instance = new _CubismShader_WebGL();
        return s_instance;
      }
      return s_instance;
    }
    static deleteInstance() {
      if (s_instance) {
        s_instance.release();
        s_instance = void 0;
      }
    }
    constructor() {
      this._shaderSets = [];
    }
    release() {
      this.releaseShaderProgram();
    }
    setupShaderProgram(renderer, textureId, vertexCount, vertexArray, indexArray, uvArray, bufferData, opacity, colorBlendMode, baseColor, isPremultipliedAlpha, matrix4x4, invertedMask) {
      if (!isPremultipliedAlpha) {
        CubismLogError("NoPremultipliedAlpha is not allowed");
      }
      if (this._shaderSets.length == 0) {
        this.generateShaders();
      }
      let SRC_COLOR;
      let DST_COLOR;
      let SRC_ALPHA;
      let DST_ALPHA;
      const clippingContextBufferForMask = renderer.getClippingContextBufferForMask();
      if (clippingContextBufferForMask != null) {
        const shaderSet = this._shaderSets[ShaderNames.ShaderNames_SetupMask];
        this.gl.useProgram(shaderSet.shaderProgram);
        this.gl.activeTexture(this.gl.TEXTURE0);
        this.gl.bindTexture(this.gl.TEXTURE_2D, textureId);
        this.gl.uniform1i(shaderSet.samplerTexture0Location, 0);
        if (bufferData.vertex == null) {
          bufferData.vertex = this.gl.createBuffer();
        }
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, bufferData.vertex);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, vertexArray, this.gl.DYNAMIC_DRAW);
        this.gl.enableVertexAttribArray(shaderSet.attributePositionLocation);
        this.gl.vertexAttribPointer(shaderSet.attributePositionLocation, 2, this.gl.FLOAT, false, 0, 0);
        if (bufferData.uv == null) {
          bufferData.uv = this.gl.createBuffer();
        }
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, bufferData.uv);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, uvArray, this.gl.DYNAMIC_DRAW);
        this.gl.enableVertexAttribArray(shaderSet.attributeTexCoordLocation);
        this.gl.vertexAttribPointer(shaderSet.attributeTexCoordLocation, 2, this.gl.FLOAT, false, 0, 0);
        const channelNo = clippingContextBufferForMask._layoutChannelNo;
        const colorChannel = clippingContextBufferForMask.getClippingManager().getChannelFlagAsColor(channelNo);
        this.gl.uniform4f(shaderSet.uniformChannelFlagLocation, colorChannel.R, colorChannel.G, colorChannel.B, colorChannel.A);
        this.gl.uniformMatrix4fv(shaderSet.uniformClipMatrixLocation, false, clippingContextBufferForMask._matrixForMask.getArray());
        const rect = clippingContextBufferForMask._layoutBounds;
        this.gl.uniform4f(shaderSet.uniformBaseColorLocation, rect.x * 2 - 1, rect.y * 2 - 1, rect.getRight() * 2 - 1, rect.getBottom() * 2 - 1);
        SRC_COLOR = this.gl.ZERO;
        DST_COLOR = this.gl.ONE_MINUS_SRC_COLOR;
        SRC_ALPHA = this.gl.ZERO;
        DST_ALPHA = this.gl.ONE_MINUS_SRC_ALPHA;
      } else {
        const clippingContextBufferForDraw = renderer.getClippingContextBufferForDraw();
        const masked = clippingContextBufferForDraw != null;
        const offset = masked ? invertedMask ? 2 : 1 : 0;
        let shaderSet;
        switch (colorBlendMode) {
          case CubismBlendMode.CubismBlendMode_Normal:
          default:
            shaderSet = this._shaderSets[ShaderNames.ShaderNames_NormalPremultipliedAlpha + offset];
            SRC_COLOR = this.gl.ONE;
            DST_COLOR = this.gl.ONE_MINUS_SRC_ALPHA;
            SRC_ALPHA = this.gl.ONE;
            DST_ALPHA = this.gl.ONE_MINUS_SRC_ALPHA;
            break;
          case CubismBlendMode.CubismBlendMode_Additive:
            shaderSet = this._shaderSets[ShaderNames.ShaderNames_AddPremultipliedAlpha + offset];
            SRC_COLOR = this.gl.ONE;
            DST_COLOR = this.gl.ONE;
            SRC_ALPHA = this.gl.ZERO;
            DST_ALPHA = this.gl.ONE;
            break;
          case CubismBlendMode.CubismBlendMode_Multiplicative:
            shaderSet = this._shaderSets[ShaderNames.ShaderNames_MultPremultipliedAlpha + offset];
            SRC_COLOR = this.gl.DST_COLOR;
            DST_COLOR = this.gl.ONE_MINUS_SRC_ALPHA;
            SRC_ALPHA = this.gl.ZERO;
            DST_ALPHA = this.gl.ONE;
            break;
        }
        this.gl.useProgram(shaderSet.shaderProgram);
        if (bufferData.vertex == null) {
          bufferData.vertex = this.gl.createBuffer();
        }
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, bufferData.vertex);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, vertexArray, this.gl.DYNAMIC_DRAW);
        this.gl.enableVertexAttribArray(shaderSet.attributePositionLocation);
        this.gl.vertexAttribPointer(shaderSet.attributePositionLocation, 2, this.gl.FLOAT, false, 0, 0);
        if (bufferData.uv == null) {
          bufferData.uv = this.gl.createBuffer();
        }
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, bufferData.uv);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, uvArray, this.gl.DYNAMIC_DRAW);
        this.gl.enableVertexAttribArray(shaderSet.attributeTexCoordLocation);
        this.gl.vertexAttribPointer(shaderSet.attributeTexCoordLocation, 2, this.gl.FLOAT, false, 0, 0);
        if (clippingContextBufferForDraw != null) {
          this.gl.activeTexture(this.gl.TEXTURE1);
          const tex = clippingContextBufferForDraw.getClippingManager().getColorBuffer();
          this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
          this.gl.uniform1i(shaderSet.samplerTexture1Location, 1);
          this.gl.uniformMatrix4fv(shaderSet.uniformClipMatrixLocation, false, clippingContextBufferForDraw._matrixForDraw.getArray());
          const channelNo = clippingContextBufferForDraw._layoutChannelNo;
          const colorChannel = clippingContextBufferForDraw.getClippingManager().getChannelFlagAsColor(channelNo);
          this.gl.uniform4f(shaderSet.uniformChannelFlagLocation, colorChannel.R, colorChannel.G, colorChannel.B, colorChannel.A);
        }
        this.gl.activeTexture(this.gl.TEXTURE0);
        this.gl.bindTexture(this.gl.TEXTURE_2D, textureId);
        this.gl.uniform1i(shaderSet.samplerTexture0Location, 0);
        this.gl.uniformMatrix4fv(shaderSet.uniformMatrixLocation, false, matrix4x4.getArray());
        this.gl.uniform4f(shaderSet.uniformBaseColorLocation, baseColor.R, baseColor.G, baseColor.B, baseColor.A);
      }
      if (bufferData.index == null) {
        bufferData.index = this.gl.createBuffer();
      }
      this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, bufferData.index);
      this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, indexArray, this.gl.DYNAMIC_DRAW);
      this.gl.blendFuncSeparate(SRC_COLOR, DST_COLOR, SRC_ALPHA, DST_ALPHA);
    }
    releaseShaderProgram() {
      for (let i = 0; i < this._shaderSets.length; i++) {
        this.gl.deleteProgram(this._shaderSets[i].shaderProgram);
        this._shaderSets[i].shaderProgram = 0;
      }
      this._shaderSets = [];
    }
    generateShaders() {
      for (let i = 0; i < shaderCount; i++) {
        this._shaderSets.push({});
      }
      this._shaderSets[0].shaderProgram = this.loadShaderProgram(vertexShaderSrcSetupMask, fragmentShaderSrcsetupMask);
      this._shaderSets[1].shaderProgram = this.loadShaderProgram(vertexShaderSrc, fragmentShaderSrcPremultipliedAlpha);
      this._shaderSets[2].shaderProgram = this.loadShaderProgram(vertexShaderSrcMasked, fragmentShaderSrcMaskPremultipliedAlpha);
      this._shaderSets[3].shaderProgram = this.loadShaderProgram(vertexShaderSrcMasked, fragmentShaderSrcMaskInvertedPremultipliedAlpha);
      this._shaderSets[4].shaderProgram = this._shaderSets[1].shaderProgram;
      this._shaderSets[5].shaderProgram = this._shaderSets[2].shaderProgram;
      this._shaderSets[6].shaderProgram = this._shaderSets[3].shaderProgram;
      this._shaderSets[7].shaderProgram = this._shaderSets[1].shaderProgram;
      this._shaderSets[8].shaderProgram = this._shaderSets[2].shaderProgram;
      this._shaderSets[9].shaderProgram = this._shaderSets[3].shaderProgram;
      this._shaderSets[0].attributePositionLocation = this.gl.getAttribLocation(this._shaderSets[0].shaderProgram, "a_position");
      this._shaderSets[0].attributeTexCoordLocation = this.gl.getAttribLocation(this._shaderSets[0].shaderProgram, "a_texCoord");
      this._shaderSets[0].samplerTexture0Location = this.gl.getUniformLocation(this._shaderSets[0].shaderProgram, "s_texture0");
      this._shaderSets[0].uniformClipMatrixLocation = this.gl.getUniformLocation(this._shaderSets[0].shaderProgram, "u_clipMatrix");
      this._shaderSets[0].uniformChannelFlagLocation = this.gl.getUniformLocation(this._shaderSets[0].shaderProgram, "u_channelFlag");
      this._shaderSets[0].uniformBaseColorLocation = this.gl.getUniformLocation(this._shaderSets[0].shaderProgram, "u_baseColor");
      this._shaderSets[1].attributePositionLocation = this.gl.getAttribLocation(this._shaderSets[1].shaderProgram, "a_position");
      this._shaderSets[1].attributeTexCoordLocation = this.gl.getAttribLocation(this._shaderSets[1].shaderProgram, "a_texCoord");
      this._shaderSets[1].samplerTexture0Location = this.gl.getUniformLocation(this._shaderSets[1].shaderProgram, "s_texture0");
      this._shaderSets[1].uniformMatrixLocation = this.gl.getUniformLocation(this._shaderSets[1].shaderProgram, "u_matrix");
      this._shaderSets[1].uniformBaseColorLocation = this.gl.getUniformLocation(this._shaderSets[1].shaderProgram, "u_baseColor");
      this._shaderSets[2].attributePositionLocation = this.gl.getAttribLocation(this._shaderSets[2].shaderProgram, "a_position");
      this._shaderSets[2].attributeTexCoordLocation = this.gl.getAttribLocation(this._shaderSets[2].shaderProgram, "a_texCoord");
      this._shaderSets[2].samplerTexture0Location = this.gl.getUniformLocation(this._shaderSets[2].shaderProgram, "s_texture0");
      this._shaderSets[2].samplerTexture1Location = this.gl.getUniformLocation(this._shaderSets[2].shaderProgram, "s_texture1");
      this._shaderSets[2].uniformMatrixLocation = this.gl.getUniformLocation(this._shaderSets[2].shaderProgram, "u_matrix");
      this._shaderSets[2].uniformClipMatrixLocation = this.gl.getUniformLocation(this._shaderSets[2].shaderProgram, "u_clipMatrix");
      this._shaderSets[2].uniformChannelFlagLocation = this.gl.getUniformLocation(this._shaderSets[2].shaderProgram, "u_channelFlag");
      this._shaderSets[2].uniformBaseColorLocation = this.gl.getUniformLocation(this._shaderSets[2].shaderProgram, "u_baseColor");
      this._shaderSets[3].attributePositionLocation = this.gl.getAttribLocation(this._shaderSets[3].shaderProgram, "a_position");
      this._shaderSets[3].attributeTexCoordLocation = this.gl.getAttribLocation(this._shaderSets[3].shaderProgram, "a_texCoord");
      this._shaderSets[3].samplerTexture0Location = this.gl.getUniformLocation(this._shaderSets[3].shaderProgram, "s_texture0");
      this._shaderSets[3].samplerTexture1Location = this.gl.getUniformLocation(this._shaderSets[3].shaderProgram, "s_texture1");
      this._shaderSets[3].uniformMatrixLocation = this.gl.getUniformLocation(this._shaderSets[3].shaderProgram, "u_matrix");
      this._shaderSets[3].uniformClipMatrixLocation = this.gl.getUniformLocation(this._shaderSets[3].shaderProgram, "u_clipMatrix");
      this._shaderSets[3].uniformChannelFlagLocation = this.gl.getUniformLocation(this._shaderSets[3].shaderProgram, "u_channelFlag");
      this._shaderSets[3].uniformBaseColorLocation = this.gl.getUniformLocation(this._shaderSets[3].shaderProgram, "u_baseColor");
      this._shaderSets[4].attributePositionLocation = this.gl.getAttribLocation(this._shaderSets[4].shaderProgram, "a_position");
      this._shaderSets[4].attributeTexCoordLocation = this.gl.getAttribLocation(this._shaderSets[4].shaderProgram, "a_texCoord");
      this._shaderSets[4].samplerTexture0Location = this.gl.getUniformLocation(this._shaderSets[4].shaderProgram, "s_texture0");
      this._shaderSets[4].uniformMatrixLocation = this.gl.getUniformLocation(this._shaderSets[4].shaderProgram, "u_matrix");
      this._shaderSets[4].uniformBaseColorLocation = this.gl.getUniformLocation(this._shaderSets[4].shaderProgram, "u_baseColor");
      this._shaderSets[5].attributePositionLocation = this.gl.getAttribLocation(this._shaderSets[5].shaderProgram, "a_position");
      this._shaderSets[5].attributeTexCoordLocation = this.gl.getAttribLocation(this._shaderSets[5].shaderProgram, "a_texCoord");
      this._shaderSets[5].samplerTexture0Location = this.gl.getUniformLocation(this._shaderSets[5].shaderProgram, "s_texture0");
      this._shaderSets[5].samplerTexture1Location = this.gl.getUniformLocation(this._shaderSets[5].shaderProgram, "s_texture1");
      this._shaderSets[5].uniformMatrixLocation = this.gl.getUniformLocation(this._shaderSets[5].shaderProgram, "u_matrix");
      this._shaderSets[5].uniformClipMatrixLocation = this.gl.getUniformLocation(this._shaderSets[5].shaderProgram, "u_clipMatrix");
      this._shaderSets[5].uniformChannelFlagLocation = this.gl.getUniformLocation(this._shaderSets[5].shaderProgram, "u_channelFlag");
      this._shaderSets[5].uniformBaseColorLocation = this.gl.getUniformLocation(this._shaderSets[5].shaderProgram, "u_baseColor");
      this._shaderSets[6].attributePositionLocation = this.gl.getAttribLocation(this._shaderSets[6].shaderProgram, "a_position");
      this._shaderSets[6].attributeTexCoordLocation = this.gl.getAttribLocation(this._shaderSets[6].shaderProgram, "a_texCoord");
      this._shaderSets[6].samplerTexture0Location = this.gl.getUniformLocation(this._shaderSets[6].shaderProgram, "s_texture0");
      this._shaderSets[6].samplerTexture1Location = this.gl.getUniformLocation(this._shaderSets[6].shaderProgram, "s_texture1");
      this._shaderSets[6].uniformMatrixLocation = this.gl.getUniformLocation(this._shaderSets[6].shaderProgram, "u_matrix");
      this._shaderSets[6].uniformClipMatrixLocation = this.gl.getUniformLocation(this._shaderSets[6].shaderProgram, "u_clipMatrix");
      this._shaderSets[6].uniformChannelFlagLocation = this.gl.getUniformLocation(this._shaderSets[6].shaderProgram, "u_channelFlag");
      this._shaderSets[6].uniformBaseColorLocation = this.gl.getUniformLocation(this._shaderSets[6].shaderProgram, "u_baseColor");
      this._shaderSets[7].attributePositionLocation = this.gl.getAttribLocation(this._shaderSets[7].shaderProgram, "a_position");
      this._shaderSets[7].attributeTexCoordLocation = this.gl.getAttribLocation(this._shaderSets[7].shaderProgram, "a_texCoord");
      this._shaderSets[7].samplerTexture0Location = this.gl.getUniformLocation(this._shaderSets[7].shaderProgram, "s_texture0");
      this._shaderSets[7].uniformMatrixLocation = this.gl.getUniformLocation(this._shaderSets[7].shaderProgram, "u_matrix");
      this._shaderSets[7].uniformBaseColorLocation = this.gl.getUniformLocation(this._shaderSets[7].shaderProgram, "u_baseColor");
      this._shaderSets[8].attributePositionLocation = this.gl.getAttribLocation(this._shaderSets[8].shaderProgram, "a_position");
      this._shaderSets[8].attributeTexCoordLocation = this.gl.getAttribLocation(this._shaderSets[8].shaderProgram, "a_texCoord");
      this._shaderSets[8].samplerTexture0Location = this.gl.getUniformLocation(this._shaderSets[8].shaderProgram, "s_texture0");
      this._shaderSets[8].samplerTexture1Location = this.gl.getUniformLocation(this._shaderSets[8].shaderProgram, "s_texture1");
      this._shaderSets[8].uniformMatrixLocation = this.gl.getUniformLocation(this._shaderSets[8].shaderProgram, "u_matrix");
      this._shaderSets[8].uniformClipMatrixLocation = this.gl.getUniformLocation(this._shaderSets[8].shaderProgram, "u_clipMatrix");
      this._shaderSets[8].uniformChannelFlagLocation = this.gl.getUniformLocation(this._shaderSets[8].shaderProgram, "u_channelFlag");
      this._shaderSets[8].uniformBaseColorLocation = this.gl.getUniformLocation(this._shaderSets[8].shaderProgram, "u_baseColor");
      this._shaderSets[9].attributePositionLocation = this.gl.getAttribLocation(this._shaderSets[9].shaderProgram, "a_position");
      this._shaderSets[9].attributeTexCoordLocation = this.gl.getAttribLocation(this._shaderSets[9].shaderProgram, "a_texCoord");
      this._shaderSets[9].samplerTexture0Location = this.gl.getUniformLocation(this._shaderSets[9].shaderProgram, "s_texture0");
      this._shaderSets[9].samplerTexture1Location = this.gl.getUniformLocation(this._shaderSets[9].shaderProgram, "s_texture1");
      this._shaderSets[9].uniformMatrixLocation = this.gl.getUniformLocation(this._shaderSets[9].shaderProgram, "u_matrix");
      this._shaderSets[9].uniformClipMatrixLocation = this.gl.getUniformLocation(this._shaderSets[9].shaderProgram, "u_clipMatrix");
      this._shaderSets[9].uniformChannelFlagLocation = this.gl.getUniformLocation(this._shaderSets[9].shaderProgram, "u_channelFlag");
      this._shaderSets[9].uniformBaseColorLocation = this.gl.getUniformLocation(this._shaderSets[9].shaderProgram, "u_baseColor");
    }
    loadShaderProgram(vertexShaderSource, fragmentShaderSource) {
      let shaderProgram = this.gl.createProgram();
      let vertShader = this.compileShaderSource(this.gl.VERTEX_SHADER, vertexShaderSource);
      if (!vertShader) {
        CubismLogError("Vertex shader compile error!");
        return 0;
      }
      let fragShader = this.compileShaderSource(this.gl.FRAGMENT_SHADER, fragmentShaderSource);
      if (!fragShader) {
        CubismLogError("Vertex shader compile error!");
        return 0;
      }
      this.gl.attachShader(shaderProgram, vertShader);
      this.gl.attachShader(shaderProgram, fragShader);
      this.gl.linkProgram(shaderProgram);
      const linkStatus = this.gl.getProgramParameter(shaderProgram, this.gl.LINK_STATUS);
      if (!linkStatus) {
        CubismLogError("Failed to link program: {0}", shaderProgram);
        this.gl.deleteShader(vertShader);
        this.gl.deleteShader(fragShader);
        if (shaderProgram) {
          this.gl.deleteProgram(shaderProgram);
        }
        return 0;
      }
      this.gl.deleteShader(vertShader);
      this.gl.deleteShader(fragShader);
      return shaderProgram;
    }
    compileShaderSource(shaderType, shaderSource) {
      const source = shaderSource;
      const shader = this.gl.createShader(shaderType);
      this.gl.shaderSource(shader, source);
      this.gl.compileShader(shader);
      if (!shader) {
        const log = this.gl.getShaderInfoLog(shader);
        CubismLogError("Shader compile log: {0} ", log);
      }
      const status = this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS);
      if (!status) {
        this.gl.deleteShader(shader);
        return null;
      }
      return shader;
    }
    setGl(gl) {
      this.gl = gl;
    }
  };
  var ShaderNames = /* @__PURE__ */ ((ShaderNames2) => {
    ShaderNames2[ShaderNames2["ShaderNames_SetupMask"] = 0] = "ShaderNames_SetupMask";
    ShaderNames2[ShaderNames2["ShaderNames_NormalPremultipliedAlpha"] = 1] = "ShaderNames_NormalPremultipliedAlpha";
    ShaderNames2[ShaderNames2["ShaderNames_NormalMaskedPremultipliedAlpha"] = 2] = "ShaderNames_NormalMaskedPremultipliedAlpha";
    ShaderNames2[ShaderNames2["ShaderNames_NomralMaskedInvertedPremultipliedAlpha"] = 3] = "ShaderNames_NomralMaskedInvertedPremultipliedAlpha";
    ShaderNames2[ShaderNames2["ShaderNames_AddPremultipliedAlpha"] = 4] = "ShaderNames_AddPremultipliedAlpha";
    ShaderNames2[ShaderNames2["ShaderNames_AddMaskedPremultipliedAlpha"] = 5] = "ShaderNames_AddMaskedPremultipliedAlpha";
    ShaderNames2[ShaderNames2["ShaderNames_AddMaskedPremultipliedAlphaInverted"] = 6] = "ShaderNames_AddMaskedPremultipliedAlphaInverted";
    ShaderNames2[ShaderNames2["ShaderNames_MultPremultipliedAlpha"] = 7] = "ShaderNames_MultPremultipliedAlpha";
    ShaderNames2[ShaderNames2["ShaderNames_MultMaskedPremultipliedAlpha"] = 8] = "ShaderNames_MultMaskedPremultipliedAlpha";
    ShaderNames2[ShaderNames2["ShaderNames_MultMaskedPremultipliedAlphaInverted"] = 9] = "ShaderNames_MultMaskedPremultipliedAlphaInverted";
    return ShaderNames2;
  })(ShaderNames || {});
  var vertexShaderSrcSetupMask = "attribute vec4     a_position;attribute vec2     a_texCoord;varying vec2       v_texCoord;varying vec4       v_myPos;uniform mat4       u_clipMatrix;void main(){   gl_Position = u_clipMatrix * a_position;   v_myPos = u_clipMatrix * a_position;   v_texCoord = a_texCoord;   v_texCoord.y = 1.0 - v_texCoord.y;}";
  var fragmentShaderSrcsetupMask = "precision mediump float;varying vec2       v_texCoord;varying vec4       v_myPos;uniform vec4       u_baseColor;uniform vec4       u_channelFlag;uniform sampler2D  s_texture0;void main(){   float isInside =        step(u_baseColor.x, v_myPos.x/v_myPos.w)       * step(u_baseColor.y, v_myPos.y/v_myPos.w)       * step(v_myPos.x/v_myPos.w, u_baseColor.z)       * step(v_myPos.y/v_myPos.w, u_baseColor.w);   gl_FragColor = u_channelFlag * texture2D(s_texture0, v_texCoord).a * isInside;}";
  var vertexShaderSrc = "attribute vec4     a_position;attribute vec2     a_texCoord;varying vec2       v_texCoord;uniform mat4       u_matrix;void main(){   gl_Position = u_matrix * a_position;   v_texCoord = a_texCoord;   v_texCoord.y = 1.0 - v_texCoord.y;}";
  var vertexShaderSrcMasked = "attribute vec4     a_position;attribute vec2     a_texCoord;varying vec2       v_texCoord;varying vec4       v_clipPos;uniform mat4       u_matrix;uniform mat4       u_clipMatrix;void main(){   gl_Position = u_matrix * a_position;   v_clipPos = u_clipMatrix * a_position;   v_texCoord = a_texCoord;   v_texCoord.y = 1.0 - v_texCoord.y;}";
  var fragmentShaderSrcPremultipliedAlpha = "precision mediump float;varying vec2       v_texCoord;uniform vec4       u_baseColor;uniform sampler2D  s_texture0;void main(){   gl_FragColor = texture2D(s_texture0 , v_texCoord) * u_baseColor;}";
  var fragmentShaderSrcMaskPremultipliedAlpha = "precision mediump float;varying vec2       v_texCoord;varying vec4       v_clipPos;uniform vec4       u_baseColor;uniform vec4       u_channelFlag;uniform sampler2D  s_texture0;uniform sampler2D  s_texture1;void main(){   vec4 col_formask = texture2D(s_texture0 , v_texCoord) * u_baseColor;   vec4 clipMask = (1.0 - texture2D(s_texture1, v_clipPos.xy / v_clipPos.w)) * u_channelFlag;   float maskVal = clipMask.r + clipMask.g + clipMask.b + clipMask.a;   col_formask = col_formask * maskVal;   gl_FragColor = col_formask;}";
  var fragmentShaderSrcMaskInvertedPremultipliedAlpha = "precision mediump float;varying vec2 v_texCoord;varying vec4 v_clipPos;uniform sampler2D s_texture0;uniform sampler2D s_texture1;uniform vec4 u_channelFlag;uniform vec4 u_baseColor;void main(){vec4 col_formask = texture2D(s_texture0, v_texCoord) * u_baseColor;vec4 clipMask = (1.0 - texture2D(s_texture1, v_clipPos.xy / v_clipPos.w)) * u_channelFlag;float maskVal = clipMask.r + clipMask.g + clipMask.b + clipMask.a;col_formask = col_formask * (1.0 - maskVal);gl_FragColor = col_formask;}";
  var CubismRenderer_WebGL = class extends CubismRenderer {
    constructor() {
      super();
      this._clippingContextBufferForMask = null;
      this._clippingContextBufferForDraw = null;
      this._clippingManager = new CubismClippingManager_WebGL();
      this.firstDraw = true;
      this._textures = {};
      this._sortedDrawableIndexList = [];
      this._bufferData = {
        vertex: null,
        uv: null,
        index: null
      };
    }
    initialize(model) {
      if (model.isUsingMasking()) {
        this._clippingManager = new CubismClippingManager_WebGL();
        this._clippingManager.initialize(model, model.getDrawableCount(), model.getDrawableMasks(), model.getDrawableMaskCounts());
      }
      for (let i = model.getDrawableCount() - 1; i >= 0; i--) {
        this._sortedDrawableIndexList[i] = 0;
      }
      super.initialize(model);
    }
    bindTexture(modelTextureNo, glTexture) {
      this._textures[modelTextureNo] = glTexture;
    }
    getBindedTextures() {
      return this._textures;
    }
    setClippingMaskBufferSize(size) {
      this._clippingManager.release();
      this._clippingManager = new CubismClippingManager_WebGL();
      this._clippingManager.setClippingMaskBufferSize(size);
      this._clippingManager.initialize(this.getModel(), this.getModel().getDrawableCount(), this.getModel().getDrawableMasks(), this.getModel().getDrawableMaskCounts());
    }
    getClippingMaskBufferSize() {
      return this._clippingManager.getClippingMaskBufferSize();
    }
    release() {
      var _a, _b, _c;
      const self2 = this;
      this._clippingManager.release();
      self2._clippingManager = void 0;
      (_a = this.gl) == null ? void 0 : _a.deleteBuffer(this._bufferData.vertex);
      this._bufferData.vertex = null;
      (_b = this.gl) == null ? void 0 : _b.deleteBuffer(this._bufferData.uv);
      this._bufferData.uv = null;
      (_c = this.gl) == null ? void 0 : _c.deleteBuffer(this._bufferData.index);
      this._bufferData.index = null;
      self2._bufferData = void 0;
      self2._textures = void 0;
    }
    doDrawModel() {
      this.preDraw();
      if (this._clippingManager != null) {
        this._clippingManager.setupClippingContext(this.getModel(), this);
      }
      const drawableCount = this.getModel().getDrawableCount();
      const renderOrder = this.getModel().getDrawableRenderOrders();
      for (let i = 0; i < drawableCount; ++i) {
        const order = renderOrder[i];
        this._sortedDrawableIndexList[order] = i;
      }
      for (let i = 0; i < drawableCount; ++i) {
        const drawableIndex = this._sortedDrawableIndexList[i];
        if (!this.getModel().getDrawableDynamicFlagIsVisible(drawableIndex)) {
          continue;
        }
        this.setClippingContextBufferForDraw(this._clippingManager != null ? this._clippingManager.getClippingContextListForDraw()[drawableIndex] : null);
        this.setIsCulling(this.getModel().getDrawableCulling(drawableIndex));
        this.drawMesh(this.getModel().getDrawableTextureIndices(drawableIndex), this.getModel().getDrawableVertexIndexCount(drawableIndex), this.getModel().getDrawableVertexCount(drawableIndex), this.getModel().getDrawableVertexIndices(drawableIndex), this.getModel().getDrawableVertices(drawableIndex), this.getModel().getDrawableVertexUvs(drawableIndex), this.getModel().getDrawableOpacity(drawableIndex), this.getModel().getDrawableBlendMode(drawableIndex), this.getModel().getDrawableInvertedMaskBit(drawableIndex));
      }
    }
    drawMesh(textureNo, indexCount, vertexCount, indexArray, vertexArray, uvArray, opacity, colorBlendMode, invertedMask) {
      if (this.isCulling()) {
        this.gl.enable(this.gl.CULL_FACE);
      } else {
        this.gl.disable(this.gl.CULL_FACE);
      }
      this.gl.frontFace(this.gl.CCW);
      const modelColorRGBA = this.getModelColor();
      if (this.getClippingContextBufferForMask() == null) {
        modelColorRGBA.A *= opacity;
        if (this.isPremultipliedAlpha()) {
          modelColorRGBA.R *= modelColorRGBA.A;
          modelColorRGBA.G *= modelColorRGBA.A;
          modelColorRGBA.B *= modelColorRGBA.A;
        }
      }
      let drawtexture = null;
      if (this._textures[textureNo] != null) {
        drawtexture = this._textures[textureNo];
      }
      CubismShader_WebGL.getInstance().setupShaderProgram(this, drawtexture, vertexCount, vertexArray, indexArray, uvArray, this._bufferData, opacity, colorBlendMode, modelColorRGBA, this.isPremultipliedAlpha(), this.getMvpMatrix(), invertedMask);
      this.gl.drawElements(this.gl.TRIANGLES, indexCount, this.gl.UNSIGNED_SHORT, 0);
      this.gl.useProgram(null);
      this.setClippingContextBufferForDraw(null);
      this.setClippingContextBufferForMask(null);
    }
    static doStaticRelease() {
      CubismShader_WebGL.deleteInstance();
    }
    setRenderState(fbo, viewport) {
      s_fbo = fbo;
      s_viewport = viewport;
    }
    preDraw() {
      if (this.firstDraw) {
        this.firstDraw = false;
        this._anisortopy = this.gl.getExtension("EXT_texture_filter_anisotropic") || this.gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic") || this.gl.getExtension("MOZ_EXT_texture_filter_anisotropic");
      }
      this.gl.disable(this.gl.SCISSOR_TEST);
      this.gl.disable(this.gl.STENCIL_TEST);
      this.gl.disable(this.gl.DEPTH_TEST);
      this.gl.frontFace(this.gl.CW);
      this.gl.enable(this.gl.BLEND);
      this.gl.colorMask(true, true, true, true);
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
      this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, null);
    }
    setClippingContextBufferForMask(clip) {
      this._clippingContextBufferForMask = clip;
    }
    getClippingContextBufferForMask() {
      return this._clippingContextBufferForMask;
    }
    setClippingContextBufferForDraw(clip) {
      this._clippingContextBufferForDraw = clip;
    }
    getClippingContextBufferForDraw() {
      return this._clippingContextBufferForDraw;
    }
    startUp(gl) {
      this.gl = gl;
      this._clippingManager.setGL(gl);
      CubismShader_WebGL.getInstance().setGl(gl);
    }
  };
  CubismRenderer.staticRelease = () => {
    CubismRenderer_WebGL.doStaticRelease();
  };
  var CubismModelSettingsJson = class {
    constructor(json) {
      this.groups = json.Groups;
      this.hitAreas = json.HitAreas;
      this.layout = json.Layout;
      this.moc = json.FileReferences.Moc;
      this.expressions = json.FileReferences.Expressions;
      this.motions = json.FileReferences.Motions;
      this.textures = json.FileReferences.Textures;
      this.physics = json.FileReferences.Physics;
      this.pose = json.FileReferences.Pose;
    }
    getEyeBlinkParameters() {
      var _a, _b;
      return (_b = (_a = this.groups) == null ? void 0 : _a.find((group) => group.Name === "EyeBlink")) == null ? void 0 : _b.Ids;
    }
    getLipSyncParameters() {
      var _a, _b;
      return (_b = (_a = this.groups) == null ? void 0 : _a.find((group) => group.Name === "LipSync")) == null ? void 0 : _b.Ids;
    }
  };
  var ParamAngleX = "ParamAngleX";
  var ParamAngleY = "ParamAngleY";
  var ParamAngleZ = "ParamAngleZ";
  var ParamEyeBallX = "ParamEyeBallX";
  var ParamEyeBallY = "ParamEyeBallY";
  var ParamBodyAngleX = "ParamBodyAngleX";
  var ParamBreath = "ParamBreath";
  var LOGICAL_WIDTH = 2;
  var LOGICAL_HEIGHT = 2;
  var config;
  ((config2) => {
    config2.LOG_LEVEL_VERBOSE = 0;
    config2.LOG_LEVEL_WARNING = 1;
    config2.LOG_LEVEL_ERROR = 2;
    config2.LOG_LEVEL_NONE = 999;
    config2.logLevel = config2.LOG_LEVEL_WARNING;
    config2.sound = true;
    config2.motionSync = true;
    config2.motionFadingDuration = 500;
    config2.idleMotionFadingDuration = 2e3;
    config2.expressionFadingDuration = 500;
    config2.preserveExpressionOnMotion = true;
    config2.cubism4 = CubismConfig;
  })(config || (config = {}));
  var logger = {
    log(tag, ...messages) {
      if (config.logLevel <= config.LOG_LEVEL_VERBOSE) {
        console.log(`[${tag}]`, ...messages);
      }
    },
    warn(tag, ...messages) {
      if (config.logLevel <= config.LOG_LEVEL_WARNING) {
        console.warn(`[${tag}]`, ...messages);
      }
    },
    error(tag, ...messages) {
      if (config.logLevel <= config.LOG_LEVEL_ERROR) {
        console.error(`[${tag}]`, ...messages);
      }
    }
  };
  function clamp(num, lower, upper) {
    return num < lower ? lower : num > upper ? upper : num;
  }
  function applyMixins(derivedCtor, baseCtors) {
    baseCtors.forEach((baseCtor) => {
      Object.getOwnPropertyNames(baseCtor.prototype).forEach((name) => {
        if (name !== "constructor") {
          Object.defineProperty(derivedCtor.prototype, name, Object.getOwnPropertyDescriptor(baseCtor.prototype, name));
        }
      });
    });
  }
  function folderName(url2) {
    let lastSlashIndex = url2.lastIndexOf("/");
    if (lastSlashIndex != -1) {
      url2 = url2.slice(0, lastSlashIndex);
    }
    lastSlashIndex = url2.lastIndexOf("/");
    if (lastSlashIndex !== -1) {
      url2 = url2.slice(lastSlashIndex + 1);
    }
    return url2;
  }
  function remove(array, item) {
    const index = array.indexOf(item);
    if (index !== -1) {
      array.splice(index, 1);
    }
  }
  var ExpressionManager = class extends import_eventemitter3.default {
    constructor(settings2, options) {
      super();
      this.expressions = [];
      this.reserveExpressionIndex = -1;
      this.destroyed = false;
      this.settings = settings2;
      this.tag = `ExpressionManager(${settings2.name})`;
    }
    init() {
      this.defaultExpression = this.createExpression({}, void 0);
      this.currentExpression = this.defaultExpression;
      this.stopAllExpressions();
    }
    loadExpression(index) {
      return __async(this, null, function* () {
        if (!this.definitions[index]) {
          logger.warn(this.tag, `Undefined expression at [${index}]`);
          return void 0;
        }
        if (this.expressions[index] === null) {
          logger.warn(this.tag, `Cannot set expression at [${index}] because it's already failed in loading.`);
          return void 0;
        }
        if (this.expressions[index]) {
          return this.expressions[index];
        }
        const expression = yield this._loadExpression(index);
        this.expressions[index] = expression;
        return expression;
      });
    }
    _loadExpression(index) {
      throw new Error("Not implemented.");
    }
    setRandomExpression() {
      return __async(this, null, function* () {
        if (this.definitions.length) {
          const availableIndices = [];
          for (let i = 0; i < this.definitions.length; i++) {
            if (this.expressions[i] !== null && this.expressions[i] !== this.currentExpression && i !== this.reserveExpressionIndex) {
              availableIndices.push(i);
            }
          }
          if (availableIndices.length) {
            const index = Math.floor(Math.random() * availableIndices.length);
            return this.setExpression(index);
          }
        }
        return false;
      });
    }
    resetExpression() {
      this._setExpression(this.defaultExpression);
    }
    restoreExpression() {
      this._setExpression(this.currentExpression);
    }
    setExpression(index) {
      return __async(this, null, function* () {
        if (typeof index !== "number") {
          index = this.getExpressionIndex(index);
        }
        if (!(index > -1 && index < this.definitions.length)) {
          return false;
        }
        if (index === this.expressions.indexOf(this.currentExpression)) {
          return false;
        }
        this.reserveExpressionIndex = index;
        const expression = yield this.loadExpression(index);
        if (!expression || this.reserveExpressionIndex !== index) {
          return false;
        }
        this.reserveExpressionIndex = -1;
        this.currentExpression = expression;
        this._setExpression(expression);
        return true;
      });
    }
    update(model, now) {
      if (!this.isFinished()) {
        return this.updateParameters(model, now);
      }
      return false;
    }
    destroy() {
      this.destroyed = true;
      this.emit("destroy");
      const self2 = this;
      self2.definitions = void 0;
      self2.expressions = void 0;
    }
  };
  var EPSILON = 0.01;
  var MAX_SPEED = 40 / 7.5;
  var ACCELERATION_TIME = 1 / (0.15 * 1e3);
  var FocusController = class {
    constructor() {
      this.targetX = 0;
      this.targetY = 0;
      this.x = 0;
      this.y = 0;
      this.vx = 0;
      this.vy = 0;
    }
    focus(x, y, instant = false) {
      this.targetX = clamp(x, -1, 1);
      this.targetY = clamp(y, -1, 1);
      if (instant) {
        this.x = this.targetX;
        this.y = this.targetY;
      }
    }
    update(dt) {
      const dx = this.targetX - this.x;
      const dy = this.targetY - this.y;
      if (Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON)
        return;
      const d = Math.sqrt(__pow(dx, 2) + __pow(dy, 2));
      const maxSpeed = MAX_SPEED / (1e3 / dt);
      let ax = maxSpeed * (dx / d) - this.vx;
      let ay = maxSpeed * (dy / d) - this.vy;
      const a = Math.sqrt(__pow(ax, 2) + __pow(ay, 2));
      const maxA = maxSpeed * ACCELERATION_TIME * dt;
      if (a > maxA) {
        ax *= maxA / a;
        ay *= maxA / a;
      }
      this.vx += ax;
      this.vy += ay;
      const v = Math.sqrt(__pow(this.vx, 2) + __pow(this.vy, 2));
      const maxV = 0.5 * (Math.sqrt(__pow(maxA, 2) + 8 * maxA * d) - maxA);
      if (v > maxV) {
        this.vx *= maxV / v;
        this.vy *= maxV / v;
      }
      this.x += this.vx;
      this.y += this.vy;
    }
  };
  var ModelSettings = class {
    constructor(json) {
      this.json = json;
      let url2 = json.url;
      if (typeof url2 !== "string") {
        throw new TypeError("The `url` field in settings JSON must be defined as a string.");
      }
      this.url = url2;
      this.name = folderName(this.url);
    }
    resolveURL(path) {
      return url.resolve(this.url, path);
    }
    replaceFiles(replacer) {
      this.moc = replacer(this.moc, "moc");
      if (this.pose !== void 0) {
        this.pose = replacer(this.pose, "pose");
      }
      if (this.physics !== void 0) {
        this.physics = replacer(this.physics, "physics");
      }
      for (let i = 0; i < this.textures.length; i++) {
        this.textures[i] = replacer(this.textures[i], `textures[${i}]`);
      }
    }
    getDefinedFiles() {
      const files = [];
      this.replaceFiles((file) => {
        files.push(file);
        return file;
      });
      return files;
    }
    validateFiles(files) {
      const assertFileExists = (expectedFile, shouldThrow) => {
        const actualPath = this.resolveURL(expectedFile);
        if (!files.includes(actualPath)) {
          if (shouldThrow) {
            throw new Error(`File "${expectedFile}" is defined in settings, but doesn't exist in given files`);
          }
          return false;
        }
        return true;
      };
      const essentialFiles = [this.moc, ...this.textures];
      essentialFiles.forEach((texture) => assertFileExists(texture, true));
      const definedFiles = this.getDefinedFiles();
      return definedFiles.filter((file) => assertFileExists(file, false));
    }
  };
  var MotionPriority = /* @__PURE__ */ ((MotionPriority2) => {
    MotionPriority2[MotionPriority2["NONE"] = 0] = "NONE";
    MotionPriority2[MotionPriority2["IDLE"] = 1] = "IDLE";
    MotionPriority2[MotionPriority2["NORMAL"] = 2] = "NORMAL";
    MotionPriority2[MotionPriority2["FORCE"] = 3] = "FORCE";
    return MotionPriority2;
  })(MotionPriority || {});
  var MotionState = class {
    constructor() {
      this.debug = false;
      this.currentPriority = 0;
      this.reservePriority = 0;
    }
    reserve(group, index, priority) {
      if (priority <= 0) {
        logger.log(this.tag, `Cannot start a motion with MotionPriority.NONE.`);
        return false;
      }
      if (group === this.currentGroup && index === this.currentIndex) {
        logger.log(this.tag, `Motion is already playing.`, this.dump(group, index));
        return false;
      }
      if (group === this.reservedGroup && index === this.reservedIndex || group === this.reservedIdleGroup && index === this.reservedIdleIndex) {
        logger.log(this.tag, `Motion is already reserved.`, this.dump(group, index));
        return false;
      }
      if (priority === 1) {
        if (this.currentPriority !== 0) {
          logger.log(this.tag, `Cannot start idle motion because another motion is playing.`, this.dump(group, index));
          return false;
        }
        if (this.reservedIdleGroup !== void 0) {
          logger.log(this.tag, `Cannot start idle motion because another idle motion has reserved.`, this.dump(group, index));
          return false;
        }
        this.setReservedIdle(group, index);
      } else {
        if (priority < 3) {
          if (priority <= this.currentPriority) {
            logger.log(this.tag, "Cannot start motion because another motion is playing as an equivalent or higher priority.", this.dump(group, index));
            return false;
          }
          if (priority <= this.reservePriority) {
            logger.log(this.tag, "Cannot start motion because another motion has reserved as an equivalent or higher priority.", this.dump(group, index));
            return false;
          }
        }
        this.setReserved(group, index, priority);
      }
      return true;
    }
    start(motion, group, index, priority) {
      if (priority === 1) {
        this.setReservedIdle(void 0, void 0);
        if (this.currentPriority !== 0) {
          logger.log(this.tag, "Cannot start idle motion because another motion is playing.", this.dump(group, index));
          return false;
        }
      } else {
        if (group !== this.reservedGroup || index !== this.reservedIndex) {
          logger.log(this.tag, "Cannot start motion because another motion has taken the place.", this.dump(group, index));
          return false;
        }
        this.setReserved(void 0, void 0, 0);
      }
      if (!motion) {
        return false;
      }
      this.setCurrent(group, index, priority);
      return true;
    }
    complete() {
      this.setCurrent(void 0, void 0, 0);
    }
    setCurrent(group, index, priority) {
      this.currentPriority = priority;
      this.currentGroup = group;
      this.currentIndex = index;
    }
    setReserved(group, index, priority) {
      this.reservePriority = priority;
      this.reservedGroup = group;
      this.reservedIndex = index;
    }
    setReservedIdle(group, index) {
      this.reservedIdleGroup = group;
      this.reservedIdleIndex = index;
    }
    isActive(group, index) {
      return group === this.currentGroup && index === this.currentIndex || group === this.reservedGroup && index === this.reservedIndex || group === this.reservedIdleGroup && index === this.reservedIdleIndex;
    }
    reset() {
      this.setCurrent(void 0, void 0, 0);
      this.setReserved(void 0, void 0, 0);
      this.setReservedIdle(void 0, void 0);
    }
    shouldRequestIdleMotion() {
      return this.currentGroup === void 0 && this.reservedIdleGroup === void 0;
    }
    shouldOverrideExpression() {
      return !config.preserveExpressionOnMotion && this.currentPriority > 1;
    }
    dump(requestedGroup, requestedIndex) {
      if (this.debug) {
        const keys = [
          "currentPriority",
          "reservePriority",
          "currentGroup",
          "currentIndex",
          "reservedGroup",
          "reservedIndex",
          "reservedIdleGroup",
          "reservedIdleIndex"
        ];
        return `
<Requested> group = "${requestedGroup}", index = ${requestedIndex}
` + keys.map((key) => "[" + key + "] " + this[key]).join("\n");
      }
      return "";
    }
  };
  var TAG$2 = "SoundManager";
  var VOLUME = 0.5;
  var SoundManager = class {
    static get volume() {
      return this._volume;
    }
    static set volume(value) {
      this._volume = (value > 1 ? 1 : value < 0 ? 0 : value) || 0;
      this.audios.forEach((audio) => audio.volume = this._volume);
    }
    static add(file, onFinish, onError) {
      const audio = new Audio(file);
      audio.volume = this._volume;
      audio.preload = "auto";
      audio.addEventListener("ended", () => {
        this.dispose(audio);
        onFinish == null ? void 0 : onFinish();
      });
      audio.addEventListener("error", (e) => {
        this.dispose(audio);
        logger.warn(TAG$2, `Error occurred on "${file}"`, e.error);
        onError == null ? void 0 : onError(e.error);
      });
      this.audios.push(audio);
      return audio;
    }
    static play(audio) {
      return new Promise((resolve2, reject) => {
        var _a;
        (_a = audio.play()) == null ? void 0 : _a.catch((e) => {
          audio.dispatchEvent(new ErrorEvent("error", { error: e }));
          reject(e);
        });
        if (audio.readyState === audio.HAVE_ENOUGH_DATA) {
          resolve2();
        } else {
          audio.addEventListener("canplaythrough", resolve2);
        }
      });
    }
    static dispose(audio) {
      audio.pause();
      audio.removeAttribute("src");
      remove(this.audios, audio);
    }
    static destroy() {
      for (let i = this.audios.length - 1; i >= 0; i--) {
        this.dispose(this.audios[i]);
      }
    }
  };
  SoundManager.audios = [];
  SoundManager._volume = VOLUME;
  var MotionManager = class extends import_eventemitter3.default {
    constructor(settings2, options) {
      super();
      this.motionGroups = {};
      this.state = new MotionState();
      this.playing = false;
      this.destroyed = false;
      this.settings = settings2;
      this.tag = `MotionManager(${settings2.name})`;
      this.state.tag = this.tag;
    }
    init(options) {
      if (options == null ? void 0 : options.idleMotionGroup) {
        this.groups.idle = options.idleMotionGroup;
      }
      this.setupMotions(options);
      this.stopAllMotions();
    }
    setupMotions(options) {
      for (const group of Object.keys(this.definitions)) {
        this.motionGroups[group] = [];
      }
      let groups;
      switch (options == null ? void 0 : options.motionPreload) {
        case "NONE":
          return;
        case "ALL":
          groups = Object.keys(this.definitions);
          break;
        case "IDLE":
        default:
          groups = [this.groups.idle];
          break;
      }
      for (const group of groups) {
        if (this.definitions[group]) {
          for (let i = 0; i < this.definitions[group].length; i++) {
            this.loadMotion(group, i).then();
          }
        }
      }
    }
    loadMotion(group, index) {
      return __async(this, null, function* () {
        var _a;
        if (!((_a = this.definitions[group]) == null ? void 0 : _a[index])) {
          logger.warn(this.tag, `Undefined motion at "${group}"[${index}]`);
          return void 0;
        }
        if (this.motionGroups[group][index] === null) {
          logger.warn(this.tag, `Cannot start motion at "${group}"[${index}] because it's already failed in loading.`);
          return void 0;
        }
        if (this.motionGroups[group][index]) {
          return this.motionGroups[group][index];
        }
        const motion = yield this._loadMotion(group, index);
        if (this.destroyed) {
          return;
        }
        this.motionGroups[group][index] = motion != null ? motion : null;
        return motion;
      });
    }
    _loadMotion(group, index) {
      throw new Error("Not implemented.");
    }
    startMotion(_0, _1) {
      return __async(this, arguments, function* (group, index, priority = MotionPriority.NORMAL) {
        var _a;
        if (!this.state.reserve(group, index, priority)) {
          return false;
        }
        const definition = (_a = this.definitions[group]) == null ? void 0 : _a[index];
        if (!definition) {
          return false;
        }
        if (this.currentAudio) {
          SoundManager.dispose(this.currentAudio);
        }
        let audio;
        if (config.sound) {
          const soundURL = this.getSoundFile(definition);
          if (soundURL) {
            try {
              audio = SoundManager.add(this.settings.resolveURL(soundURL), () => this.currentAudio = void 0, () => this.currentAudio = void 0);
              this.currentAudio = audio;
            } catch (e) {
              logger.warn(this.tag, "Failed to create audio", soundURL, e);
            }
          }
        }
        const motion = yield this.loadMotion(group, index);
        if (audio) {
          const readyToPlay = SoundManager.play(audio).catch((e) => logger.warn(this.tag, "Failed to play audio", audio.src, e));
          if (config.motionSync) {
            yield readyToPlay;
          }
        }
        if (!this.state.start(motion, group, index, priority)) {
          if (audio) {
            SoundManager.dispose(audio);
            this.currentAudio = void 0;
          }
          return false;
        }
        logger.log(this.tag, "Start motion:", this.getMotionName(definition));
        this.emit("motionStart", group, index, audio);
        if (this.state.shouldOverrideExpression()) {
          this.expressionManager && this.expressionManager.resetExpression();
        }
        this.playing = true;
        this._startMotion(motion);
        return true;
      });
    }
    startRandomMotion(group, priority) {
      return __async(this, null, function* () {
        const groupDefs = this.definitions[group];
        if (groupDefs == null ? void 0 : groupDefs.length) {
          const availableIndices = [];
          for (let i = 0; i < groupDefs.length; i++) {
            if (this.motionGroups[group][i] !== null && !this.state.isActive(group, i)) {
              availableIndices.push(i);
            }
          }
          if (availableIndices.length) {
            const index = Math.floor(Math.random() * availableIndices.length);
            return this.startMotion(group, availableIndices[index], priority);
          }
        }
        return false;
      });
    }
    stopAllMotions() {
      this._stopAllMotions();
      this.state.reset();
      if (this.currentAudio) {
        SoundManager.dispose(this.currentAudio);
        this.currentAudio = void 0;
      }
    }
    update(model, now) {
      var _a;
      if (this.isFinished()) {
        if (this.playing) {
          this.playing = false;
          this.emit("motionFinish");
        }
        if (this.state.shouldOverrideExpression()) {
          (_a = this.expressionManager) == null ? void 0 : _a.restoreExpression();
        }
        this.state.complete();
        if (this.state.shouldRequestIdleMotion()) {
          this.startRandomMotion(this.groups.idle, MotionPriority.IDLE);
        }
      }
      return this.updateParameters(model, now);
    }
    destroy() {
      var _a;
      this.destroyed = true;
      this.emit("destroy");
      this.stopAllMotions();
      (_a = this.expressionManager) == null ? void 0 : _a.destroy();
      const self2 = this;
      self2.definitions = void 0;
      self2.motionGroups = void 0;
    }
  };
  var tempBounds = { x: 0, y: 0, width: 0, height: 0 };
  var InternalModel = class extends import_eventemitter3.default {
    constructor() {
      super(...arguments);
      this.focusController = new FocusController();
      this.originalWidth = 0;
      this.originalHeight = 0;
      this.width = 0;
      this.height = 0;
      this.localTransform = new Matrix();
      this.drawingMatrix = new Matrix();
      this.hitAreas = {};
      this.textureFlipY = false;
      this.viewport = [0, 0, 0, 0];
      this.destroyed = false;
    }
    init() {
      this.setupLayout();
      this.setupHitAreas();
    }
    setupLayout() {
      const self2 = this;
      const size = this.getSize();
      self2.originalWidth = size[0];
      self2.originalHeight = size[1];
      const layout = Object.assign({
        width: LOGICAL_WIDTH,
        height: LOGICAL_HEIGHT
      }, this.getLayout());
      this.localTransform.scale(layout.width / LOGICAL_WIDTH, layout.height / LOGICAL_HEIGHT);
      self2.width = this.originalWidth * this.localTransform.a;
      self2.height = this.originalHeight * this.localTransform.d;
      const offsetX = layout.x !== void 0 && layout.x - layout.width / 2 || layout.centerX !== void 0 && layout.centerX || layout.left !== void 0 && layout.left - layout.width / 2 || layout.right !== void 0 && layout.right + layout.width / 2 || 0;
      const offsetY = layout.y !== void 0 && layout.y - layout.height / 2 || layout.centerY !== void 0 && layout.centerY || layout.top !== void 0 && layout.top - layout.height / 2 || layout.bottom !== void 0 && layout.bottom + layout.height / 2 || 0;
      this.localTransform.translate(this.width * offsetX, -this.height * offsetY);
    }
    setupHitAreas() {
      const definitions = this.getHitAreaDefs().filter((hitArea) => hitArea.index >= 0);
      for (const def of definitions) {
        this.hitAreas[def.name] = def;
      }
    }
    hitTest(x, y) {
      return Object.keys(this.hitAreas).filter((hitAreaName) => this.isHit(hitAreaName, x, y));
    }
    isHit(hitAreaName, x, y) {
      if (!this.hitAreas[hitAreaName]) {
        return false;
      }
      const drawIndex = this.hitAreas[hitAreaName].index;
      const bounds = this.getDrawableBounds(drawIndex, tempBounds);
      return bounds.x <= x && x <= bounds.x + bounds.width && bounds.y <= y && y <= bounds.y + bounds.height;
    }
    getDrawableBounds(index, bounds) {
      const vertices = this.getDrawableVertices(index);
      let left = vertices[0];
      let right = vertices[0];
      let top = vertices[1];
      let bottom = vertices[1];
      for (let i = 0; i < vertices.length; i += 2) {
        const vx2 = vertices[i];
        const vy2 = vertices[i + 1];
        left = Math.min(vx2, left);
        right = Math.max(vx2, right);
        top = Math.min(vy2, top);
        bottom = Math.max(vy2, bottom);
      }
      bounds != null ? bounds : bounds = {};
      bounds.x = left;
      bounds.y = top;
      bounds.width = right - left;
      bounds.height = bottom - top;
      return bounds;
    }
    updateTransform(transform) {
      this.drawingMatrix.copyFrom(transform).append(this.localTransform);
    }
    update(dt, now) {
      this.focusController.update(dt);
    }
    destroy() {
      this.destroyed = true;
      this.emit("destroy");
      this.motionManager.destroy();
      this.motionManager = void 0;
    }
  };
  var TAG$1 = "XHRLoader";
  var NetworkError = class extends Error {
    constructor(message, url2, status, aborted = false) {
      super(message);
      this.url = url2;
      this.status = status;
      this.aborted = aborted;
    }
  };
  var _XHRLoader = class {
    static createXHR(target, url2, type, onload, onerror) {
      const xhr = new XMLHttpRequest();
      _XHRLoader.allXhrSet.add(xhr);
      if (target) {
        let xhrSet = _XHRLoader.xhrMap.get(target);
        if (!xhrSet) {
          xhrSet = /* @__PURE__ */ new Set([xhr]);
          _XHRLoader.xhrMap.set(target, xhrSet);
        } else {
          xhrSet.add(xhr);
        }
        if (!target.listeners("destroy").includes(_XHRLoader.cancelXHRs)) {
          target.once("destroy", _XHRLoader.cancelXHRs);
        }
      }
      xhr.open("GET", url2);
      xhr.responseType = type;
      xhr.onload = () => {
        if ((xhr.status === 200 || xhr.status === 0) && xhr.response) {
          onload(xhr.response);
        } else {
          xhr.onerror();
        }
      };
      xhr.onerror = () => {
        logger.warn(TAG$1, `Failed to load resource as ${xhr.responseType} (Status ${xhr.status}): ${url2}`);
        onerror(new NetworkError("Network error.", url2, xhr.status));
      };
      xhr.onabort = () => onerror(new NetworkError("Aborted.", url2, xhr.status, true));
      xhr.onloadend = () => {
        var _a;
        _XHRLoader.allXhrSet.delete(xhr);
        if (target) {
          (_a = _XHRLoader.xhrMap.get(target)) == null ? void 0 : _a.delete(xhr);
        }
      };
      return xhr;
    }
    static cancelXHRs() {
      var _a;
      (_a = _XHRLoader.xhrMap.get(this)) == null ? void 0 : _a.forEach((xhr) => {
        xhr.abort();
        _XHRLoader.allXhrSet.delete(xhr);
      });
      _XHRLoader.xhrMap.delete(this);
    }
    static release() {
      _XHRLoader.allXhrSet.forEach((xhr) => xhr.abort());
      _XHRLoader.allXhrSet.clear();
      _XHRLoader.xhrMap = /* @__PURE__ */ new WeakMap();
    }
  };
  var XHRLoader = _XHRLoader;
  XHRLoader.xhrMap = /* @__PURE__ */ new WeakMap();
  XHRLoader.allXhrSet = /* @__PURE__ */ new Set();
  XHRLoader.loader = (context2, next) => {
    return new Promise((resolve2, reject) => {
      const xhr = _XHRLoader.createXHR(context2.target, context2.settings ? context2.settings.resolveURL(context2.url) : context2.url, context2.type, (data) => {
        context2.result = data;
        resolve2();
      }, reject);
      xhr.send();
    });
  };
  function runMiddlewares(middleware, context2) {
    let index = -1;
    return dispatch2(0);
    function dispatch2(i, err) {
      if (err)
        return Promise.reject(err);
      if (i <= index)
        return Promise.reject(new Error("next() called multiple times"));
      index = i;
      const fn = middleware[i];
      if (!fn)
        return Promise.resolve();
      try {
        return Promise.resolve(fn(context2, dispatch2.bind(null, i + 1)));
      } catch (err2) {
        return Promise.reject(err2);
      }
    }
  }
  var Live2DLoader = class {
    static load(context2) {
      return runMiddlewares(this.middlewares, context2).then(() => context2.result);
    }
  };
  Live2DLoader.middlewares = [XHRLoader.loader];
  function createTexture(url2, options = {}) {
    var _a;
    const textureOptions = { resourceOptions: { crossorigin: options.crossOrigin } };
    if (Texture.fromURL) {
      return Texture.fromURL(url2, textureOptions).catch((e) => {
        if (e instanceof Error) {
          throw e;
        }
        const err = new Error("Texture loading error");
        err.event = e;
        throw err;
      });
    }
    textureOptions.resourceOptions.autoLoad = false;
    const texture = Texture.from(url2, textureOptions);
    if (texture.baseTexture.valid) {
      return Promise.resolve(texture);
    }
    const resource = texture.baseTexture.resource;
    (_a = resource._live2d_load) != null ? _a : resource._live2d_load = new Promise((resolve2, reject) => {
      const errorHandler = (event) => {
        resource.source.removeEventListener("error", errorHandler);
        const err = new Error("Texture loading error");
        err.event = event;
        reject(err);
      };
      resource.source.addEventListener("error", errorHandler);
      resource.load().then(() => resolve2(texture)).catch(errorHandler);
    });
    return resource._live2d_load;
  }
  var TAG = "Live2DFactory";
  var urlToJSON = (context2, next) => __async(void 0, null, function* () {
    if (typeof context2.source === "string") {
      const data = yield Live2DLoader.load({
        url: context2.source,
        type: "json",
        target: context2.live2dModel
      });
      data.url = context2.source;
      context2.source = data;
      context2.live2dModel.emit("settingsJSONLoaded", data);
    }
    return next();
  });
  var jsonToSettings = (context2, next) => __async(void 0, null, function* () {
    if (context2.source instanceof ModelSettings) {
      context2.settings = context2.source;
      return next();
    } else if (typeof context2.source === "object") {
      const runtime = Live2DFactory.findRuntime(context2.source);
      if (runtime) {
        const settings2 = runtime.createModelSettings(context2.source);
        context2.settings = settings2;
        context2.live2dModel.emit("settingsLoaded", settings2);
        return next();
      }
    }
    throw new TypeError("Unknown settings format.");
  });
  var waitUntilReady = (context2, next) => {
    if (context2.settings) {
      const runtime = Live2DFactory.findRuntime(context2.settings);
      if (runtime) {
        return runtime.ready().then(next);
      }
    }
    return next();
  };
  var setupOptionals = (context2, next) => __async(void 0, null, function* () {
    yield next();
    const internalModel = context2.internalModel;
    if (internalModel) {
      const settings2 = context2.settings;
      const runtime = Live2DFactory.findRuntime(settings2);
      if (runtime) {
        const tasks = [];
        if (settings2.pose) {
          tasks.push(Live2DLoader.load({
            settings: settings2,
            url: settings2.pose,
            type: "json",
            target: internalModel
          }).then((data) => {
            internalModel.pose = runtime.createPose(internalModel.coreModel, data);
            context2.live2dModel.emit("poseLoaded", internalModel.pose);
          }).catch((e) => {
            context2.live2dModel.emit("poseLoadError", e);
            logger.warn(TAG, "Failed to load pose.", e);
          }));
        }
        if (settings2.physics) {
          tasks.push(Live2DLoader.load({
            settings: settings2,
            url: settings2.physics,
            type: "json",
            target: internalModel
          }).then((data) => {
            internalModel.physics = runtime.createPhysics(internalModel.coreModel, data);
            context2.live2dModel.emit("physicsLoaded", internalModel.physics);
          }).catch((e) => {
            context2.live2dModel.emit("physicsLoadError", e);
            logger.warn(TAG, "Failed to load physics.", e);
          }));
        }
        if (tasks.length) {
          yield Promise.all(tasks);
        }
      }
    }
  });
  var setupEssentials = (context2, next) => __async(void 0, null, function* () {
    if (context2.settings) {
      const live2DModel = context2.live2dModel;
      const textureLoadings = context2.settings.textures.map((tex) => {
        const url2 = context2.settings.resolveURL(tex);
        return createTexture(url2, { crossOrigin: context2.options.crossOrigin });
      });
      yield next();
      if (context2.internalModel) {
        live2DModel.internalModel = context2.internalModel;
        live2DModel.emit("modelLoaded", context2.internalModel);
      } else {
        throw new TypeError("Missing internal model.");
      }
      live2DModel.textures = yield Promise.all(textureLoadings);
      live2DModel.emit("textureLoaded", live2DModel.textures);
    } else {
      throw new TypeError("Missing settings.");
    }
  });
  var createInternalModel = (context2, next) => __async(void 0, null, function* () {
    const settings2 = context2.settings;
    if (settings2 instanceof ModelSettings) {
      const runtime = Live2DFactory.findRuntime(settings2);
      if (!runtime) {
        throw new TypeError("Unknown model settings.");
      }
      const modelData = yield Live2DLoader.load({
        settings: settings2,
        url: settings2.moc,
        type: "arraybuffer",
        target: context2.live2dModel
      });
      if (!runtime.isValidMoc(modelData)) {
        throw new Error("Invalid moc data");
      }
      const coreModel = runtime.createCoreModel(modelData);
      context2.internalModel = runtime.createInternalModel(coreModel, settings2, context2.options);
      return next();
    }
    throw new TypeError("Missing settings.");
  });
  var _Live2DFactory = class {
    static registerRuntime(runtime) {
      _Live2DFactory.runtimes.push(runtime);
      _Live2DFactory.runtimes.sort((a, b) => b.version - a.version);
    }
    static findRuntime(source) {
      for (const runtime of _Live2DFactory.runtimes) {
        if (runtime.test(source)) {
          return runtime;
        }
      }
    }
    static setupLive2DModel(live2dModel, source, options) {
      return __async(this, null, function* () {
        const textureLoaded = new Promise((resolve2) => live2dModel.once("textureLoaded", resolve2));
        const modelLoaded = new Promise((resolve2) => live2dModel.once("modelLoaded", resolve2));
        const readyEventEmitted = Promise.all([textureLoaded, modelLoaded]).then(() => live2dModel.emit("ready"));
        yield runMiddlewares(_Live2DFactory.live2DModelMiddlewares, {
          live2dModel,
          source,
          options: options || {}
        });
        yield readyEventEmitted;
        live2dModel.emit("load");
      });
    }
    static loadMotion(motionManager, group, index) {
      var _a, _b;
      const handleError = (e) => motionManager.emit("motionLoadError", group, index, e);
      try {
        const definition = (_a = motionManager.definitions[group]) == null ? void 0 : _a[index];
        if (!definition) {
          return Promise.resolve(void 0);
        }
        if (!motionManager.listeners("destroy").includes(_Live2DFactory.releaseTasks)) {
          motionManager.once("destroy", _Live2DFactory.releaseTasks);
        }
        let tasks = _Live2DFactory.motionTasksMap.get(motionManager);
        if (!tasks) {
          tasks = {};
          _Live2DFactory.motionTasksMap.set(motionManager, tasks);
        }
        let taskGroup = tasks[group];
        if (!taskGroup) {
          taskGroup = [];
          tasks[group] = taskGroup;
        }
        const path = motionManager.getMotionFile(definition);
        (_b = taskGroup[index]) != null ? _b : taskGroup[index] = Live2DLoader.load({
          url: path,
          settings: motionManager.settings,
          type: motionManager.motionDataType,
          target: motionManager
        }).then((data) => {
          var _a2;
          const taskGroup2 = (_a2 = _Live2DFactory.motionTasksMap.get(motionManager)) == null ? void 0 : _a2[group];
          if (taskGroup2) {
            delete taskGroup2[index];
          }
          const motion = motionManager.createMotion(data, group, definition);
          motionManager.emit("motionLoaded", group, index, motion);
          return motion;
        }).catch((e) => {
          logger.warn(motionManager.tag, `Failed to load motion: ${path}
`, e);
          handleError(e);
        });
        return taskGroup[index];
      } catch (e) {
        logger.warn(motionManager.tag, `Failed to load motion at "${group}"[${index}]
`, e);
        handleError(e);
      }
      return Promise.resolve(void 0);
    }
    static loadExpression(expressionManager, index) {
      var _a;
      const handleError = (e) => expressionManager.emit("expressionLoadError", index, e);
      try {
        const definition = expressionManager.definitions[index];
        if (!definition) {
          return Promise.resolve(void 0);
        }
        if (!expressionManager.listeners("destroy").includes(_Live2DFactory.releaseTasks)) {
          expressionManager.once("destroy", _Live2DFactory.releaseTasks);
        }
        let tasks = _Live2DFactory.expressionTasksMap.get(expressionManager);
        if (!tasks) {
          tasks = [];
          _Live2DFactory.expressionTasksMap.set(expressionManager, tasks);
        }
        const path = expressionManager.getExpressionFile(definition);
        (_a = tasks[index]) != null ? _a : tasks[index] = Live2DLoader.load({
          url: path,
          settings: expressionManager.settings,
          type: "json",
          target: expressionManager
        }).then((data) => {
          const tasks2 = _Live2DFactory.expressionTasksMap.get(expressionManager);
          if (tasks2) {
            delete tasks2[index];
          }
          const expression = expressionManager.createExpression(data, definition);
          expressionManager.emit("expressionLoaded", index, expression);
          return expression;
        }).catch((e) => {
          logger.warn(expressionManager.tag, `Failed to load expression: ${path}
`, e);
          handleError(e);
        });
        return tasks[index];
      } catch (e) {
        logger.warn(expressionManager.tag, `Failed to load expression at [${index}]
`, e);
        handleError(e);
      }
      return Promise.resolve(void 0);
    }
    static releaseTasks() {
      if (this instanceof MotionManager) {
        _Live2DFactory.motionTasksMap.delete(this);
      } else {
        _Live2DFactory.expressionTasksMap.delete(this);
      }
    }
  };
  var Live2DFactory = _Live2DFactory;
  Live2DFactory.runtimes = [];
  Live2DFactory.urlToJSON = urlToJSON;
  Live2DFactory.jsonToSettings = jsonToSettings;
  Live2DFactory.waitUntilReady = waitUntilReady;
  Live2DFactory.setupOptionals = setupOptionals;
  Live2DFactory.setupEssentials = setupEssentials;
  Live2DFactory.createInternalModel = createInternalModel;
  Live2DFactory.live2DModelMiddlewares = [
    urlToJSON,
    jsonToSettings,
    waitUntilReady,
    setupOptionals,
    setupEssentials,
    createInternalModel
  ];
  Live2DFactory.motionTasksMap = /* @__PURE__ */ new WeakMap();
  Live2DFactory.expressionTasksMap = /* @__PURE__ */ new WeakMap();
  MotionManager.prototype["_loadMotion"] = function(group, index) {
    return Live2DFactory.loadMotion(this, group, index);
  };
  ExpressionManager.prototype["_loadExpression"] = function(index) {
    return Live2DFactory.loadExpression(this, index);
  };
  var InteractionMixin = class {
    constructor() {
      this._autoInteract = false;
    }
    get autoInteract() {
      return this._autoInteract;
    }
    set autoInteract(autoInteract) {
      if (autoInteract !== this._autoInteract) {
        if (autoInteract) {
          this.on("pointertap", onTap, this);
        } else {
          this.off("pointertap", onTap, this);
        }
        this._autoInteract = autoInteract;
      }
    }
    registerInteraction(manager) {
      if (manager !== this.interactionManager) {
        this.unregisterInteraction();
        if (this._autoInteract && manager) {
          this.interactionManager = manager;
          manager.on("pointermove", onPointerMove, this);
        }
      }
    }
    unregisterInteraction() {
      var _a;
      if (this.interactionManager) {
        (_a = this.interactionManager) == null ? void 0 : _a.off("pointermove", onPointerMove, this);
        this.interactionManager = void 0;
      }
    }
  };
  function onTap(event) {
    this.tap(event.data.global.x, event.data.global.y);
  }
  function onPointerMove(event) {
    this.focus(event.data.global.x, event.data.global.y);
  }
  var Live2DTransform = class extends Transform {
  };
  var tempPoint = new Point();
  var tempMatrix$12 = new Matrix();
  var tickerRef;
  var Live2DModel = class extends Container {
    constructor(options) {
      super();
      this.tag = "Live2DModel(uninitialized)";
      this.textures = [];
      this.transform = new Live2DTransform();
      this.anchor = new ObservablePoint(this.onAnchorChange, this, 0, 0);
      this.glContextID = -1;
      this.elapsedTime = performance.now();
      this.deltaTime = 0;
      this._autoUpdate = false;
      this.once("modelLoaded", () => this.init(options));
    }
    static from(source, options) {
      const model = new this(options);
      return Live2DFactory.setupLive2DModel(model, source, options).then(() => model);
    }
    static fromSync(source, options) {
      const model = new this(options);
      Live2DFactory.setupLive2DModel(model, source, options).then(options == null ? void 0 : options.onLoad).catch(options == null ? void 0 : options.onError);
      return model;
    }
    static registerTicker(tickerClass) {
      tickerRef = tickerClass;
    }
    get autoUpdate() {
      return this._autoUpdate;
    }
    set autoUpdate(autoUpdate) {
      var _a;
      tickerRef || (tickerRef = (_a = window.PIXI) == null ? void 0 : _a.Ticker);
      if (autoUpdate) {
        if (!this._destroyed) {
          if (tickerRef) {
            tickerRef.shared.add(this.onTickerUpdate, this);
            this._autoUpdate = true;
          } else {
            logger.warn(this.tag, "No Ticker registered, please call Live2DModel.registerTicker(Ticker).");
          }
        }
      } else {
        tickerRef == null ? void 0 : tickerRef.shared.remove(this.onTickerUpdate, this);
        this._autoUpdate = false;
      }
    }
    init(options) {
      this.tag = `Live2DModel(${this.internalModel.settings.name})`;
      const _options = Object.assign({
        autoUpdate: true,
        autoInteract: true
      }, options);
      if (_options.autoInteract) {
        this.interactive = true;
      }
      this.autoInteract = _options.autoInteract;
      this.autoUpdate = _options.autoUpdate;
    }
    onAnchorChange() {
      this.pivot.set(this.anchor.x * this.internalModel.width, this.anchor.y * this.internalModel.height);
    }
    motion(group, index, priority) {
      return index === void 0 ? this.internalModel.motionManager.startRandomMotion(group, priority) : this.internalModel.motionManager.startMotion(group, index, priority);
    }
    expression(id) {
      if (this.internalModel.motionManager.expressionManager) {
        return id === void 0 ? this.internalModel.motionManager.expressionManager.setRandomExpression() : this.internalModel.motionManager.expressionManager.setExpression(id);
      }
      return Promise.resolve(false);
    }
    focus(x, y, instant = false) {
      tempPoint.x = x;
      tempPoint.y = y;
      this.toModelPosition(tempPoint, tempPoint, true);
      let tx = tempPoint.x / this.internalModel.originalWidth * 2 - 1;
      let ty = tempPoint.y / this.internalModel.originalHeight * 2 - 1;
      let radian = Math.atan2(ty, tx);
      this.internalModel.focusController.focus(Math.cos(radian), -Math.sin(radian), instant);
    }
    tap(x, y) {
      const hitAreaNames = this.hitTest(x, y);
      if (hitAreaNames.length) {
        logger.log(this.tag, `Hit`, hitAreaNames);
        this.emit("hit", hitAreaNames);
      }
    }
    hitTest(x, y) {
      tempPoint.x = x;
      tempPoint.y = y;
      this.toModelPosition(tempPoint, tempPoint);
      return this.internalModel.hitTest(tempPoint.x, tempPoint.y);
    }
    toModelPosition(position, result = position.clone(), skipUpdate) {
      if (!skipUpdate) {
        this._recursivePostUpdateTransform();
        if (!this.parent) {
          this.parent = this._tempDisplayObjectParent;
          this.displayObjectUpdateTransform();
          this.parent = null;
        } else {
          this.displayObjectUpdateTransform();
        }
      }
      this.transform.worldTransform.applyInverse(position, result);
      this.internalModel.localTransform.applyInverse(result, result);
      return result;
    }
    containsPoint(point) {
      return this.getBounds(true).contains(point.x, point.y);
    }
    _calculateBounds() {
      this._bounds.addFrame(this.transform, 0, 0, this.internalModel.width, this.internalModel.height);
    }
    onTickerUpdate() {
      this.update(tickerRef.shared.deltaMS);
    }
    update(dt) {
      this.deltaTime += dt;
      this.elapsedTime += dt;
    }
    _render(renderer) {
      this.registerInteraction(renderer.plugins.interaction);
      renderer.batch.reset();
      renderer.geometry.reset();
      renderer.shader.reset();
      renderer.state.reset();
      let shouldUpdateTexture = false;
      if (this.glContextID !== renderer.CONTEXT_UID) {
        this.glContextID = renderer.CONTEXT_UID;
        this.internalModel.updateWebGLContext(renderer.gl, this.glContextID);
        shouldUpdateTexture = true;
      }
      for (let i = 0; i < this.textures.length; i++) {
        const texture = this.textures[i];
        if (!texture.valid) {
          continue;
        }
        if (shouldUpdateTexture || !texture.baseTexture._glTextures[this.glContextID]) {
          renderer.gl.pixelStorei(WebGLRenderingContext.UNPACK_FLIP_Y_WEBGL, this.internalModel.textureFlipY);
          renderer.texture.bind(texture.baseTexture, 0);
        }
        this.internalModel.bindTexture(i, texture.baseTexture._glTextures[this.glContextID].texture);
        texture.baseTexture.touched = renderer.textureGC.count;
      }
      const viewport = renderer.framebuffer.viewport;
      this.internalModel.viewport = [viewport.x, viewport.y, viewport.width, viewport.height];
      if (this.deltaTime) {
        this.internalModel.update(this.deltaTime, this.elapsedTime);
        this.deltaTime = 0;
      }
      const internalTransform = tempMatrix$12.copyFrom(renderer.globalUniforms.uniforms.projectionMatrix).append(this.worldTransform);
      this.internalModel.updateTransform(internalTransform);
      this.internalModel.draw(renderer.gl);
      renderer.state.reset();
      renderer.texture.reset();
    }
    destroy(options) {
      this.emit("destroy");
      this.autoUpdate = false;
      this.unregisterInteraction();
      if (options == null ? void 0 : options.texture) {
        this.textures.forEach((texture) => texture.destroy(options.baseTexture));
      }
      this.internalModel.destroy();
      super.destroy(options);
    }
  };
  applyMixins(Live2DModel, [InteractionMixin]);
  var _FileLoader = class {
    static resolveURL(settingsURL, filePath) {
      var _a;
      const resolved = (_a = _FileLoader.filesMap[settingsURL]) == null ? void 0 : _a[filePath];
      if (resolved === void 0) {
        throw new Error("Cannot find this file from uploaded files: " + filePath);
      }
      return resolved;
    }
    static upload(files, settings2) {
      return __async(this, null, function* () {
        const fileMap = {};
        for (const definedFile of settings2.getDefinedFiles()) {
          const actualPath = decodeURI(url.resolve(settings2.url, definedFile));
          const actualFile = files.find((file) => file.webkitRelativePath === actualPath);
          if (actualFile) {
            fileMap[definedFile] = URL.createObjectURL(actualFile);
          }
        }
        _FileLoader.filesMap[settings2._objectURL] = fileMap;
      });
    }
    static createSettings(files) {
      return __async(this, null, function* () {
        const settingsFile = files.find((file) => file.name.endsWith("model.json") || file.name.endsWith("model3.json"));
        if (!settingsFile) {
          throw new TypeError("Settings file not found");
        }
        const settingsText = yield _FileLoader.readText(settingsFile);
        const settingsJSON = JSON.parse(settingsText);
        settingsJSON.url = settingsFile.webkitRelativePath;
        const runtime = Live2DFactory.findRuntime(settingsJSON);
        if (!runtime) {
          throw new Error("Unknown settings JSON");
        }
        const settings2 = runtime.createModelSettings(settingsJSON);
        settings2._objectURL = URL.createObjectURL(settingsFile);
        return settings2;
      });
    }
    static readText(file) {
      return __async(this, null, function* () {
        return new Promise((resolve2, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve2(reader.result);
          reader.onerror = reject;
          reader.readAsText(file, "utf8");
        });
      });
    }
  };
  var FileLoader = _FileLoader;
  FileLoader.filesMap = {};
  FileLoader.factory = (context2, next) => __async(void 0, null, function* () {
    if (Array.isArray(context2.source) && context2.source[0] instanceof File) {
      const files = context2.source;
      let settings2 = files.settings;
      if (!settings2) {
        settings2 = yield _FileLoader.createSettings(files);
      } else if (!settings2._objectURL) {
        throw new Error('"_objectURL" must be specified in ModelSettings');
      }
      settings2.validateFiles(files.map((file) => encodeURI(file.webkitRelativePath)));
      yield _FileLoader.upload(files, settings2);
      settings2.resolveURL = function(url2) {
        return _FileLoader.resolveURL(this._objectURL, url2);
      };
      context2.source = settings2;
      context2.live2dModel.once("modelLoaded", (internalModel) => {
        internalModel.once("destroy", function() {
          const objectURL = this.settings._objectURL;
          URL.revokeObjectURL(objectURL);
          if (_FileLoader.filesMap[objectURL]) {
            for (const resourceObjectURL of Object.values(_FileLoader.filesMap[objectURL])) {
              URL.revokeObjectURL(resourceObjectURL);
            }
          }
          delete _FileLoader.filesMap[objectURL];
        });
      });
    }
    return next();
  });
  Live2DFactory.live2DModelMiddlewares.unshift(FileLoader.factory);
  var _ZipLoader = class {
    static unzip(reader, settings2) {
      return __async(this, null, function* () {
        const filePaths = yield _ZipLoader.getFilePaths(reader);
        const requiredFilePaths = [];
        for (const definedFile of settings2.getDefinedFiles()) {
          const actualPath = decodeURI(url.resolve(settings2.url, definedFile));
          if (filePaths.includes(actualPath)) {
            requiredFilePaths.push(actualPath);
          }
        }
        const files = yield _ZipLoader.getFiles(reader, requiredFilePaths);
        for (let i = 0; i < files.length; i++) {
          const path = requiredFilePaths[i];
          const file = files[i];
          Object.defineProperty(file, "webkitRelativePath", {
            value: path
          });
        }
        return files;
      });
    }
    static createSettings(reader) {
      return __async(this, null, function* () {
        const filePaths = yield _ZipLoader.getFilePaths(reader);
        const settingsFilePath = filePaths.find((path) => path.endsWith("model.json") || path.endsWith("model3.json"));
        if (!settingsFilePath) {
          throw new Error("Settings file not found");
        }
        const settingsText = yield _ZipLoader.readText(reader, settingsFilePath);
        if (!settingsText) {
          throw new Error("Empty settings file: " + settingsFilePath);
        }
        const settingsJSON = JSON.parse(settingsText);
        settingsJSON.url = settingsFilePath;
        const runtime = Live2DFactory.findRuntime(settingsJSON);
        if (!runtime) {
          throw new Error("Unknown settings JSON");
        }
        return runtime.createModelSettings(settingsJSON);
      });
    }
    static zipReader(data, url2) {
      return __async(this, null, function* () {
        throw new Error("Not implemented");
      });
    }
    static getFilePaths(reader) {
      return __async(this, null, function* () {
        throw new Error("Not implemented");
      });
    }
    static getFiles(reader, paths) {
      return __async(this, null, function* () {
        throw new Error("Not implemented");
      });
    }
    static readText(reader, path) {
      return __async(this, null, function* () {
        throw new Error("Not implemented");
      });
    }
    static releaseReader(reader) {
    }
  };
  var ZipLoader = _ZipLoader;
  ZipLoader.ZIP_PROTOCOL = "zip://";
  ZipLoader.uid = 0;
  ZipLoader.factory = (context2, next) => __async(void 0, null, function* () {
    const source = context2.source;
    let sourceURL;
    let zipBlob;
    let settings2;
    if (typeof source === "string" && (source.endsWith(".zip") || source.startsWith(_ZipLoader.ZIP_PROTOCOL))) {
      if (source.startsWith(_ZipLoader.ZIP_PROTOCOL)) {
        sourceURL = source.slice(_ZipLoader.ZIP_PROTOCOL.length);
      } else {
        sourceURL = source;
      }
      zipBlob = yield Live2DLoader.load({
        url: sourceURL,
        type: "blob",
        target: context2.live2dModel
      });
    } else if (Array.isArray(source) && source.length === 1 && source[0] instanceof File && source[0].name.endsWith(".zip")) {
      zipBlob = source[0];
      sourceURL = URL.createObjectURL(zipBlob);
      settings2 = source.settings;
    }
    if (zipBlob) {
      if (!zipBlob.size) {
        throw new Error("Empty zip file");
      }
      const reader = yield _ZipLoader.zipReader(zipBlob, sourceURL);
      if (!settings2) {
        settings2 = yield _ZipLoader.createSettings(reader);
      }
      settings2._objectURL = _ZipLoader.ZIP_PROTOCOL + _ZipLoader.uid + "/" + settings2.url;
      const files = yield _ZipLoader.unzip(reader, settings2);
      files.settings = settings2;
      context2.source = files;
      if (sourceURL.startsWith("blob:")) {
        context2.live2dModel.once("modelLoaded", (internalModel) => {
          internalModel.once("destroy", function() {
            URL.revokeObjectURL(sourceURL);
          });
        });
      }
      _ZipLoader.releaseReader(reader);
    }
    return next();
  });
  Live2DFactory.live2DModelMiddlewares.unshift(ZipLoader.factory);
  if (!window.Live2DCubismCore) {
    throw new Error("Could not find Cubism 4 runtime. This plugin requires live2dcubismcore.js to be loaded.");
  }
  var Cubism4ExpressionManager = class extends ExpressionManager {
    constructor(settings2, options) {
      var _a;
      super(settings2, options);
      this.queueManager = new CubismMotionQueueManager();
      this.definitions = (_a = settings2.expressions) != null ? _a : [];
      this.init();
    }
    isFinished() {
      return this.queueManager.isFinished();
    }
    getExpressionIndex(name) {
      return this.definitions.findIndex((def) => def.Name === name);
    }
    getExpressionFile(definition) {
      return definition.File;
    }
    createExpression(data, definition) {
      return CubismExpressionMotion.create(data);
    }
    _setExpression(motion) {
      return this.queueManager.startMotion(motion, false, performance.now());
    }
    stopAllExpressions() {
      this.queueManager.stopAllMotions();
    }
    updateParameters(model, now) {
      return this.queueManager.doUpdateMotion(model, now);
    }
  };
  var Cubism4ModelSettings = class _Cubism4ModelSettings extends ModelSettings {
    constructor(json) {
      super(json);
      if (!_Cubism4ModelSettings.isValidJSON(json)) {
        throw new TypeError("Invalid JSON.");
      }
      Object.assign(this, new CubismModelSettingsJson(json));
    }
    static isValidJSON(json) {
      var _a;
      return !!(json == null ? void 0 : json.FileReferences) && typeof json.FileReferences.Moc === "string" && ((_a = json.FileReferences.Textures) == null ? void 0 : _a.length) > 0 && json.FileReferences.Textures.every((item) => typeof item === "string");
    }
    replaceFiles(replace) {
      super.replaceFiles(replace);
      if (this.motions) {
        for (const [group, motions] of Object.entries(this.motions)) {
          for (let i = 0; i < motions.length; i++) {
            motions[i].File = replace(motions[i].File, `motions.${group}[${i}].File`);
            if (motions[i].Sound !== void 0) {
              motions[i].Sound = replace(motions[i].Sound, `motions.${group}[${i}].Sound`);
            }
          }
        }
      }
      if (this.expressions) {
        for (let i = 0; i < this.expressions.length; i++) {
          this.expressions[i].File = replace(this.expressions[i].File, `expressions[${i}].File`);
        }
      }
    }
  };
  applyMixins(Cubism4ModelSettings, [CubismModelSettingsJson]);
  var Cubism4MotionManager = class extends MotionManager {
    constructor(settings2, options) {
      var _a;
      super(settings2, options);
      this.groups = { idle: "Idle" };
      this.motionDataType = "json";
      this.queueManager = new CubismMotionQueueManager();
      this.definitions = (_a = settings2.motions) != null ? _a : {};
      this.eyeBlinkIds = settings2.getEyeBlinkParameters() || [];
      this.lipSyncIds = settings2.getLipSyncParameters() || [];
      this.init(options);
    }
    init(options) {
      super.init(options);
      if (this.settings.expressions) {
        this.expressionManager = new Cubism4ExpressionManager(this.settings, options);
      }
      this.queueManager.setEventCallback((caller, eventValue, customData) => {
        this.emit("motion:" + eventValue);
      });
    }
    isFinished() {
      return this.queueManager.isFinished();
    }
    _startMotion(motion, onFinish) {
      motion.setFinishedMotionHandler(onFinish);
      this.queueManager.stopAllMotions();
      return this.queueManager.startMotion(motion, false, performance.now());
    }
    _stopAllMotions() {
      this.queueManager.stopAllMotions();
    }
    createMotion(data, group, definition) {
      const motion = CubismMotion.create(data);
      const json = new CubismMotionJson(data);
      const defaultFadingDuration = (group === this.groups.idle ? config.idleMotionFadingDuration : config.motionFadingDuration) / 1e3;
      if (json.getMotionFadeInTime() === void 0) {
        motion.setFadeInTime(definition.FadeInTime > 0 ? definition.FadeInTime : defaultFadingDuration);
      }
      if (json.getMotionFadeOutTime() === void 0) {
        motion.setFadeOutTime(definition.FadeOutTime > 0 ? definition.FadeOutTime : defaultFadingDuration);
      }
      motion.setEffectIds(this.eyeBlinkIds, this.lipSyncIds);
      return motion;
    }
    getMotionFile(definition) {
      return definition.File;
    }
    getMotionName(definition) {
      return definition.File;
    }
    getSoundFile(definition) {
      return definition.Sound;
    }
    updateParameters(model, now) {
      return this.queueManager.doUpdateMotion(model, now);
    }
    destroy() {
      super.destroy();
      this.queueManager.release();
      this.queueManager = void 0;
    }
  };
  var tempMatrix2 = new CubismMatrix44();
  var Cubism4InternalModel = class extends InternalModel {
    constructor(coreModel, settings2, options) {
      super();
      this.lipSync = true;
      this.breath = CubismBreath.create();
      this.renderer = new CubismRenderer_WebGL();
      this.idParamAngleX = ParamAngleX;
      this.idParamAngleY = ParamAngleY;
      this.idParamAngleZ = ParamAngleZ;
      this.idParamEyeBallX = ParamEyeBallX;
      this.idParamEyeBallY = ParamEyeBallY;
      this.idParamBodyAngleX = ParamBodyAngleX;
      this.idParamBreath = ParamBreath;
      this.pixelsPerUnit = 1;
      this.centeringTransform = new Matrix();
      this.coreModel = coreModel;
      this.settings = settings2;
      this.motionManager = new Cubism4MotionManager(settings2, options);
      this.init();
    }
    init() {
      var _a;
      super.init();
      if (((_a = this.settings.getEyeBlinkParameters()) == null ? void 0 : _a.length) > 0) {
        this.eyeBlink = CubismEyeBlink.create(this.settings);
      }
      this.breath.setParameters([
        new BreathParameterData(this.idParamAngleX, 0, 15, 6.5345, 0.5),
        new BreathParameterData(this.idParamAngleY, 0, 8, 3.5345, 0.5),
        new BreathParameterData(this.idParamAngleZ, 0, 10, 5.5345, 0.5),
        new BreathParameterData(this.idParamBodyAngleX, 0, 4, 15.5345, 0.5),
        new BreathParameterData(this.idParamBreath, 0, 0.5, 3.2345, 0.5)
      ]);
      this.renderer.initialize(this.coreModel);
      this.renderer.setIsPremultipliedAlpha(true);
    }
    getSize() {
      return [this.coreModel.getModel().canvasinfo.CanvasWidth, this.coreModel.getModel().canvasinfo.CanvasHeight];
    }
    getLayout() {
      const layout = {};
      if (this.settings.layout) {
        for (const key of Object.keys(this.settings.layout)) {
          const commonKey = key.charAt(0).toLowerCase() + key.slice(1);
          layout[commonKey] = this.settings.layout[key];
        }
      }
      return layout;
    }
    setupLayout() {
      super.setupLayout();
      this.pixelsPerUnit = this.coreModel.getModel().canvasinfo.PixelsPerUnit;
      this.centeringTransform.scale(this.pixelsPerUnit, this.pixelsPerUnit).translate(this.originalWidth / 2, this.originalHeight / 2);
    }
    updateWebGLContext(gl, glContextID) {
      this.renderer.firstDraw = true;
      this.renderer._bufferData = {
        vertex: null,
        uv: null,
        index: null
      };
      this.renderer.startUp(gl);
      this.renderer._clippingManager._currentFrameNo = glContextID;
      this.renderer._clippingManager._maskTexture = void 0;
      CubismShader_WebGL.getInstance()._shaderSets = [];
    }
    bindTexture(index, texture) {
      this.renderer.bindTexture(index, texture);
    }
    getHitAreaDefs() {
      var _a, _b;
      return (_b = (_a = this.settings.hitAreas) == null ? void 0 : _a.map((hitArea) => ({
        id: hitArea.Id,
        name: hitArea.Name,
        index: this.coreModel.getDrawableIndex(hitArea.Id)
      }))) != null ? _b : [];
    }
    getDrawableIDs() {
      return this.coreModel.getDrawableIds();
    }
    getDrawableIndex(id) {
      return this.coreModel.getDrawableIndex(id);
    }
    getDrawableVertices(drawIndex) {
      if (typeof drawIndex === "string") {
        drawIndex = this.coreModel.getDrawableIndex(drawIndex);
        if (drawIndex === -1)
          throw new TypeError("Unable to find drawable ID: " + drawIndex);
      }
      const arr = this.coreModel.getDrawableVertices(drawIndex).slice();
      for (let i = 0; i < arr.length; i += 2) {
        arr[i] = arr[i] * this.pixelsPerUnit + this.originalWidth / 2;
        arr[i + 1] = -arr[i + 1] * this.pixelsPerUnit + this.originalHeight / 2;
      }
      return arr;
    }
    updateTransform(transform) {
      this.drawingMatrix.copyFrom(this.centeringTransform).prepend(this.localTransform).prepend(transform);
    }
    update(dt, now) {
      var _a, _b, _c, _d;
      super.update(dt, now);
      dt /= 1e3;
      now /= 1e3;
      const model = this.coreModel;
      this.emit("beforeMotionUpdate");
      const motionUpdated = this.motionManager.update(this.coreModel, now);
      this.emit("afterMotionUpdate");
      model.saveParameters();
      (_a = this.motionManager.expressionManager) == null ? void 0 : _a.update(model, now);
      if (!motionUpdated) {
        (_b = this.eyeBlink) == null ? void 0 : _b.updateParameters(model, dt);
      }
      this.updateFocus();
      this.updateNaturalMovements(dt * 1e3, now * 1e3);
      (_c = this.physics) == null ? void 0 : _c.evaluate(model, dt);
      (_d = this.pose) == null ? void 0 : _d.updateParameters(model, dt);
      this.emit("beforeModelUpdate");
      model.update();
      model.loadParameters();
    }
    updateFocus() {
      this.coreModel.addParameterValueById(this.idParamEyeBallX, this.focusController.x);
      this.coreModel.addParameterValueById(this.idParamEyeBallY, this.focusController.y);
      this.coreModel.addParameterValueById(this.idParamAngleX, this.focusController.x * 30);
      this.coreModel.addParameterValueById(this.idParamAngleY, this.focusController.y * 30);
      this.coreModel.addParameterValueById(this.idParamAngleZ, this.focusController.x * this.focusController.y * -30);
      this.coreModel.addParameterValueById(this.idParamBodyAngleX, this.focusController.x * 10);
    }
    updateNaturalMovements(dt, now) {
      var _a;
      (_a = this.breath) == null ? void 0 : _a.updateParameters(this.coreModel, dt / 1e3);
    }
    draw(gl) {
      const matrix = this.drawingMatrix;
      const array = tempMatrix2.getArray();
      array[0] = matrix.a;
      array[1] = matrix.b;
      array[4] = -matrix.c;
      array[5] = -matrix.d;
      array[12] = matrix.tx;
      array[13] = matrix.ty;
      this.renderer.setMvpMatrix(tempMatrix2);
      this.renderer.setRenderState(gl.getParameter(gl.FRAMEBUFFER_BINDING), this.viewport);
      this.renderer.drawModel();
    }
    destroy() {
      super.destroy();
      this.renderer.release();
      this.coreModel.release();
      this.renderer = void 0;
      this.coreModel = void 0;
    }
  };
  var startupPromise;
  var startupRetries = 20;
  function cubism4Ready() {
    if (CubismFramework.isStarted()) {
      return Promise.resolve();
    }
    startupPromise != null ? startupPromise : startupPromise = new Promise((resolve2, reject) => {
      function startUpWithRetry() {
        try {
          startUpCubism4();
          resolve2();
        } catch (e) {
          startupRetries--;
          if (startupRetries < 0) {
            const err = new Error("Failed to start up Cubism 4 framework.");
            err.cause = e;
            reject(err);
            return;
          }
          logger.log("Cubism4", "Startup failed, retrying 10ms later...");
          setTimeout(startUpWithRetry, 10);
        }
      }
      startUpWithRetry();
    });
    return startupPromise;
  }
  function startUpCubism4(options) {
    options = Object.assign({
      logFunction: console.log,
      loggingLevel: LogLevel.LogLevel_Verbose
    }, options);
    CubismFramework.startUp(options);
    CubismFramework.initialize();
  }
  Live2DFactory.registerRuntime({
    version: 4,
    ready: cubism4Ready,
    test(source) {
      return source instanceof Cubism4ModelSettings || Cubism4ModelSettings.isValidJSON(source);
    },
    isValidMoc(modelData) {
      if (modelData.byteLength < 4) {
        return false;
      }
      const view = new Int8Array(modelData, 0, 4);
      return String.fromCharCode(...view) === "MOC3";
    },
    createModelSettings(json) {
      return new Cubism4ModelSettings(json);
    },
    createCoreModel(data) {
      const moc = CubismMoc.create(data);
      try {
        const model = moc.createModel();
        model.__moc = moc;
        return model;
      } catch (e) {
        try {
          moc.release();
        } catch (ignored2) {
        }
        throw e;
      }
    },
    createInternalModel(coreModel, settings2, options) {
      const model = new Cubism4InternalModel(coreModel, settings2, options);
      const coreModelWithMoc = coreModel;
      if (coreModelWithMoc.__moc) {
        model.__moc = coreModelWithMoc.__moc;
        delete coreModelWithMoc.__moc;
        model.once("destroy", releaseMoc);
      }
      return model;
    },
    createPhysics(coreModel, data) {
      return CubismPhysics.create(data);
    },
    createPose(coreModel, data) {
      return CubismPose.create(data);
    }
  });
  function releaseMoc() {
    var _a;
    (_a = this.__moc) == null ? void 0 : _a.release();
  }

  // src/loader/live2d-zip-loader.ts
  var import_jszip = __toESM(require_jszip_min(), 1);

  // src/loader/decode-zip-filename.ts
  function decodeZipFileName(bytes) {
    if (Array.isArray(bytes)) return bytes.join("");
    if (bytes.every((b) => b < 128)) return new TextDecoder().decode(bytes);
    try {
      return new TextDecoder("gbk").decode(bytes);
    } catch {
      return new TextDecoder().decode(bytes);
    }
  }

  // src/loader/paths.ts
  function normalizePath(path) {
    try {
      path = decodeURI(path);
    } catch {
    }
    path = path.replaceAll("\\", "/");
    if (path.startsWith("/") || /[:?#\x00-\x1f]/.test(path)) throw new Error("Unsafe model path");
    const parts = [];
    for (const p of path.split("/")) {
      if (!p || p === ".") continue;
      if (p === "..") {
        if (!parts.length) throw new Error("Model path escapes root");
        parts.pop();
      } else parts.push(p);
    }
    return parts.join("/");
  }
  function ignored(path) {
    return path.replaceAll("\\", "/").split("/").some((p) => p === "__MACOSX" || p.startsWith("._") || p === "items_pinned_to_model.json");
  }
  function selectSettings(paths) {
    const settings2 = paths.filter((p) => !ignored(p) && p.toLowerCase().endsWith(".model3.json")).sort();
    if (settings2.length !== 1) throw new Error(`Expected one model3.json, found ${settings2.length}`);
    return settings2[0];
  }
  function sanitizeSettings(value) {
    if (!value || value.Version !== 3 || !value.FileReferences || typeof value.FileReferences.Moc !== "string" || !Array.isArray(value.FileReferences.Textures) || !value.FileReferences.Textures.length) throw new Error("Invalid Cubism 3 model metadata");
    const refs = value.FileReferences;
    for (const key of ["Physics", "Pose", "DisplayInfo"]) if (refs[key] === null) delete refs[key];
    return value;
  }
  function resolveBlobResource(path) {
    if (!path.startsWith("blob:")) throw new Error("Nonlocal model reference");
    return path;
  }
  function discoverUnlistedReferences(refs, paths, root) {
    if (!refs.Expressions) refs.Expressions = paths.filter((p) => p.startsWith(root) && p.endsWith(".exp3.json")).sort().map((p) => ({ Name: p.slice(root.length).replace(/\.exp3\.json$/, ""), File: p.slice(root.length) }));
    if (!refs.Motions) {
      const files = paths.filter((p) => p.startsWith(root) && p.endsWith(".motion3.json")).sort();
      if (files.length) refs.Motions = { Imported: files.map((p) => ({ File: p.slice(root.length) })) };
    }
  }

  // src/loader/live2d-zip-loader.ts
  var activeURLs = /* @__PURE__ */ new Set();
  var activeObjectURLCount = () => activeURLs.size;
  async function request(url2, binary = false) {
    return new Promise((resolve2, reject) => {
      const x = new XMLHttpRequest();
      x.open("GET", url2);
      x.responseType = binary ? "arraybuffer" : "text";
      x.timeout = 3e4;
      x.onload = () => x.status === 200 || x.status === 0 ? resolve2(x.response) : reject(new Error("Resource unavailable: " + x.status));
      x.onerror = () => reject(new Error("Model resource request failed"));
      x.ontimeout = () => reject(new Error("Model request timed out"));
      x.send();
    });
  }
  async function loadSource(source) {
    const sourceURL = new URL(source);
    if (sourceURL.protocol !== "deskpet:" || sourceURL.hostname !== "models") throw new Error("Only managed local models are allowed");
    const blobs = [];
    const dispose = () => {
      for (const url2 of blobs.splice(0)) {
        URL.revokeObjectURL(url2);
        activeURLs.delete(url2);
      }
    };
    try {
      let archivePaths = [];
      let settingsPath, read;
      if (sourceURL.pathname.toLowerCase().endsWith(".zip")) {
        const data = await request(source, true);
        if (data.byteLength > 128 * 1024 * 1024) throw new Error("Model ZIP exceeds 128 MiB");
        const zip = await import_jszip.default.loadAsync(data, { decodeFileName: decodeZipFileName });
        const entries = /* @__PURE__ */ new Map();
        let expanded = 0;
        for (const entry of Object.values(zip.files)) {
          if (entry.dir || ignored(entry.name)) continue;
          const original = entry.unsafeOriginalName ?? entry.name;
          const key = normalizePath(original);
          if (entries.has(key)) throw new Error("Ambiguous archive path");
          expanded += entry._data?.uncompressedSize ?? 0;
          if (expanded > 256 * 1024 * 1024 || entries.size >= 2048) throw new Error("Model archive exceeds limits");
          entries.set(key, entry);
        }
        archivePaths = [...entries.keys()];
        settingsPath = selectSettings(archivePaths);
        read = async (path) => {
          const e = entries.get(normalizePath(path));
          if (!e) throw new Error("Missing model resource: " + path);
          return e.async("arraybuffer");
        };
      } else {
        if (!sourceURL.pathname.endsWith(".model3.json")) throw new Error("Expected model3.json or ZIP");
        settingsPath = decodeURIComponent(sourceURL.pathname).replace(/^\//, "");
        read = (path) => request("deskpet://models/" + normalizePath(path).split("/").map(encodeURIComponent).join("/"), true);
      }
      const root = settingsPath.slice(0, settingsPath.lastIndexOf("/") + 1);
      const settings2 = sanitizeSettings(JSON.parse(new TextDecoder().decode(await read(settingsPath))));
      const refs = settings2.FileReferences;
      discoverUnlistedReferences(refs, archivePaths, root);
      const expressions = /* @__PURE__ */ new Map();
      const resolve2 = async (path, mime = "application/octet-stream") => {
        if (typeof path !== "string") throw new Error("Invalid resource reference");
        const data = await read(normalizePath(root + path));
        const url2 = URL.createObjectURL(new Blob([data], { type: mime }));
        blobs.push(url2);
        activeURLs.add(url2);
        return url2;
      };
      for (const exp of refs.Expressions ?? []) {
        if (typeof exp.Name !== "string" || expressions.has(exp.Name)) throw new Error("Invalid expression name");
        expressions.set(exp.Name, JSON.parse(new TextDecoder().decode(await read(normalizePath(root + exp.File)))));
      }
      refs.Moc = await resolve2(refs.Moc);
      refs.Textures = await Promise.all(refs.Textures.map((p) => resolve2(p, "image/png")));
      for (const k of ["Physics", "Pose", "DisplayInfo"]) if (refs[k] !== void 0) refs[k] = await resolve2(refs[k], "application/json");
      for (const group of Object.values(refs.Motions ?? {})) for (const motion of group) {
        motion.File = await resolve2(motion.File, "application/json");
        delete motion.Sound;
      }
      delete refs.Expressions;
      settings2.url = "model.model3.json";
      return { settings: settings2, expressions, dispose };
    } catch (error) {
      dispose();
      throw error;
    }
  }

  // src/fit-model.ts
  function fitModel(w, h, mw, mh, scale = 1, x = 0, y = 0) {
    if (![w, h, mw, mh, scale, x, y].every(Number.isFinite) || Math.min(w, h, mw, mh, scale) <= 0)
      throw new Error("Invalid model or viewport geometry");
    return { scale: Math.min(w / mw, h / mh) * scale * 0.95, x: w / 2 + x, y: h / 2 + y };
  }
  function fitModelBounds(w, h, mw, mh, bounds, scale = 1, x = 0, y = 0) {
    const left = Math.min(0, bounds.left), top = Math.min(0, bounds.top), right = Math.max(mw, bounds.right), bottom = Math.max(mh, bounds.bottom);
    const fit = fitModel(w, h, right - left, bottom - top, scale, x, y);
    return { ...fit, x: fit.x - ((left + right) / 2 - mw / 2) * fit.scale, y: fit.y - ((top + bottom) / 2 - mh / 2) * fit.scale };
  }

  // src/expression-controller.ts
  var blendValue = (base, value, blend) => blend === "Add" ? base + value : blend === "Multiply" ? base * value : value;
  var ExpressionController = class {
    constructor(core, expressions, appearance = []) {
      this.core = core;
      this.appearance = appearance;
      for (const [name, raw] of expressions) {
        const data = raw;
        if (!Array.isArray(data?.Parameters)) throw new Error("Invalid expression: " + name);
        const params = data.Parameters.map((p) => {
          if (typeof p.Id !== "string" || typeof p.Value !== "number" || !Number.isFinite(p.Value) || !["Add", "Multiply", "Overwrite"].includes(p.Blend ?? "Add")) throw new Error("Invalid expression parameter");
          this.defaults.set(p.Id, core.getParameterValueById(p.Id));
          return { ...p, Blend: p.Blend ?? "Add" };
        });
        this.definitions.set(name, params);
      }
      for (const name of appearance) if (!this.definitions.has(name)) throw new Error("Unknown appearance expression: " + name);
    }
    definitions = /* @__PURE__ */ new Map();
    defaults = /* @__PURE__ */ new Map();
    active;
    list() {
      return [...this.definitions.keys()];
    }
    selectedName() {
      return this.active;
    }
    set(name) {
      if (!this.definitions.has(name)) throw new Error("Unknown expression");
      this.active = name;
    }
    clear() {
      this.active = void 0;
    }
    // Run after SDK loadParameters, before motion updates. Resets expression-only parameters
    // before motion owns them this frame; prevents accumulation and stale values on clear/swap.
    resetFrame() {
      for (const [id, value] of this.defaults) this.core.setParameterValueById(id, value);
    }
    applyFrame() {
      for (const name of [this.active ?? "", ...this.appearance]) for (const p of this.definitions.get(name) ?? []) {
        const base = p.Blend === "Add" ? this.defaults.get(p.Id) : this.core.getParameterValueById(p.Id);
        this.core.setParameterValueById(p.Id, blendValue(base, p.Value, p.Blend));
      }
    }
    reset() {
      this.clear();
      this.resetFrame();
    }
  };

  // src/motion-manager.ts
  var MotionPipeline = class {
    plugins = { pre: [], post: [], final: [] };
    register(stage2, plugin) {
      this.plugins[stage2].push(plugin);
    }
    run(stage2, dt) {
      for (const p of this.plugins[stage2]) p(dt);
    }
  };

  // src/idle-eye.ts
  var weights = [0.075, 0.11, 0.125, 0.14, 0.125, 0.05, 0.04, 0.03, 0.02, 1];
  function randomSaccadeInterval(random = Math.random) {
    let n = random(), sum = 0;
    for (let i = 0; i < weights.length; i++) {
      sum += weights[i];
      if (n <= sum) return 0.8 + i * 0.4 + random() * 0.4;
    }
    return 4.8;
  }
  var IdleEye = class {
    next = 0;
    x = 0;
    y = 0;
    update(core, dt, focus) {
      this.next -= dt;
      if (this.next <= 0) {
        this.next = randomSaccadeInterval();
        this.x = Math.random() * 2 - 1;
        this.y = Math.random() * 1.7 - 1;
      }
      const a = 1 - Math.exp(-10 * dt), target = focus ?? { x: this.x, y: this.y };
      for (const [id, value] of [["ParamEyeBallX", target.x], ["ParamEyeBallY", target.y]]) core.setParameterValueById(id, core.getParameterValueById(id) + (value - core.getParameterValueById(id)) * a);
    }
  };
  var Blink = class {
    remaining = 3 + Math.random() * 5;
    elapsed = 0;
    apply(core, dt) {
      this.remaining -= dt;
      if (this.remaining > 0) return;
      this.elapsed += dt;
      const factor = this.elapsed < 0.075 ? (1 - this.elapsed / 0.075) ** 2 : Math.min(1, ((this.elapsed - 0.075) / 0.225) ** 2);
      for (const id of ["ParamEyeLOpen", "ParamEyeROpen"]) core.setParameterValueById(id, core.getParameterValueById(id) * factor);
      if (this.elapsed >= 0.3) {
        this.elapsed = 0;
        this.remaining = 3 + Math.random() * 5;
      }
    }
  };

  // src/lip-sync.ts
  var LipSync = class {
    speaking = false;
    openness = 0;
    release = 0;
    hold = 0;
    last = 0;
    apply(core, dt) {
      if (this.speaking) {
        this.last = this.openness;
        this.release = 0.2;
        this.hold = 0.5;
        core.setParameterValueById("ParamMouthOpenY", this.openness);
      } else if (this.release > 0) {
        this.release = Math.max(0, this.release - dt);
        const t = 1 - this.release / 0.2;
        core.setParameterValueById("ParamMouthOpenY", this.last * (1 - t * t * (3 - 2 * t)));
      } else if (this.hold > 0) {
        this.hold -= dt;
        core.setParameterValueById("ParamMouthOpenY", 0);
      }
    }
  };

  // src/live2d-model.ts
  var CharacterModel = class {
    constructor(stage2) {
      this.stage = stage2;
      stage2.resized = () => this.fit();
      stage2.update = (dt) => this.model?.update(dt * 1e3);
    }
    animation = {};
    model;
    source;
    expressions;
    lip = new LipSync();
    focus;
    view = { scale: 1, x: 0, y: 0 };
    generation = 0;
    bounds = { left: 0, top: 0, right: 0, bottom: 0 };
    async load(url2, appearanceExpressions = []) {
      this.unload();
      const token = this.generation;
      emit("modelLoading");
      const start = performance.now();
      let source;
      let model;
      try {
        source = await loadSource(url2);
        model = new Live2DModel({ autoUpdate: false, autoInteract: false });
        const settings2 = new Cubism4ModelSettings(source.settings);
        settings2.resolveURL = resolveBlobResource;
        await Live2DFactory.setupLive2DModel(model, settings2, { autoUpdate: false, autoInteract: false });
        if (token !== this.generation) {
          model.destroy({ texture: true, baseTexture: true });
          source.dispose();
          return;
        }
        const im = model.internalModel, core = im.coreModel;
        this.expressions = new ExpressionController(core, source.expressions, appearanceExpressions);
        im.eyeBlink = void 0;
        const pipeline = new MotionPipeline(), idle = new IdleEye(), blink = new Blink();
        pipeline.register("pre", () => this.expressions?.resetFrame());
        pipeline.register("post", (dt) => idle.update(core, dt, this.focus));
        pipeline.register("final", () => this.expressions?.applyFrame());
        pipeline.register("final", (dt) => blink.apply(core, dt));
        pipeline.register("final", (dt) => this.lip.apply(core, dt));
        pipeline.register("final", () => {
          this.animation = { eyeOpen: core.getParameterValueById("ParamEyeLOpen"), mouthOpen: core.getParameterValueById("ParamMouthOpenY"), eyeX: core.getParameterValueById("ParamEyeBallX"), eyeY: core.getParameterValueById("ParamEyeBallY") };
        });
        let delta = 0;
        const update = im.update.bind(im);
        im.update = (dt, now) => {
          delta = Math.min(dt / 1e3, 0.1);
          update(dt, now);
        };
        im.on("beforeMotionUpdate", () => pipeline.run("pre", delta));
        im.on("beforeModelUpdate", () => {
          pipeline.run("post", delta);
          pipeline.run("final", delta);
        });
        im.motionManager.on("motionStart", (group, index) => emit("motionStarted", { group, index }));
        im.motionManager.on("motionFinish", () => emit("motionFinished"));
        this.bounds = { left: 0, top: 0, right: im.width, bottom: im.height };
        for (let i = 0; i < core.getDrawableCount(); i++) {
          if (core.getDrawableOpacity(i) <= 0) continue;
          const vertices = im.getDrawableVertices(i), t = im.localTransform;
          for (let j = 0; j < vertices.length; j += 2) {
            const x = vertices[j] * t.a + vertices[j + 1] * t.c + t.tx, y = vertices[j] * t.b + vertices[j + 1] * t.d + t.ty;
            this.bounds.left = Math.min(this.bounds.left, x);
            this.bounds.right = Math.max(this.bounds.right, x);
            this.bounds.top = Math.min(this.bounds.top, y);
            this.bounds.bottom = Math.max(this.bounds.bottom, y);
          }
        }
        this.source = source;
        this.model = model;
        model.anchor.set(0.5, 0.5);
        this.stage.app.stage.addChild(model);
        this.fit();
        emit("modelLoaded", { loadMs: performance.now() - start, ...this.capabilities() });
      } catch (e) {
        if (model?.internalModel) model.destroy({ texture: true, baseTexture: true });
        source?.dispose();
        emit("modelLoadFailed", { message: String(e), resource: e?.url ?? "" });
        throw e;
      }
    }
    fit() {
      if (!this.model) return;
      const im = this.model.internalModel;
      const v = fitModelBounds(this.stage.app.screen.width, this.stage.app.screen.height, im.width, im.height, this.bounds, this.view.scale, this.view.x, this.view.y);
      this.model.scale.set(v.scale);
      this.model.position.set(v.x, v.y);
    }
    capabilities() {
      const core = this.model?.internalModel?.coreModel;
      const ids = core?._parameterIds ?? [];
      return {
        diagnostics: {
          loadedModelCount: this.model ? 1 : 0,
          stageChildCount: this.stage.app.stage.children.length,
          activeObjectURLs: activeObjectURLCount(),
          textureCacheCount: Object.keys(TextureCache).length,
          baseTextureCacheCount: Object.keys(BaseTextureCache).length,
          rafCount: this.stage.activeRAFCount,
          preserveDrawingBuffer: this.stage.preserveDrawingBuffer,
          modelListenerCount: this.model?.eventNames().reduce((n, e) => n + this.model.listenerCount(e), 0) ?? 0,
          motionListenerCount: this.model?.internalModel.motionManager.eventNames().reduce((n, e) => n + this.model.internalModel.motionManager.listenerCount(e), 0) ?? 0
        },
        hitAreas: (this.source?.settings.HitAreas ?? []).map((area) => area.Name),
        supportsStandardMouth: ids.includes("ParamMouthOpenY"),
        supportsStandardEyeTracking: ids.includes("ParamEyeBallX") && ids.includes("ParamEyeBallY"),
        animation: this.animation,
        activeExpression: this.expressions?.selectedName() ?? null,
        motions: this.model ? Object.entries(this.model.internalModel.motionManager.definitions).flatMap(([group, v]) => (v ?? []).map((_, index) => ({ group, index }))) : [],
        expressions: this.expressions?.list() ?? [],
        fps: this.stage.measuredFPS,
        paused: this.stage.paused,
        renderScale: 1
      };
    }
    unload() {
      this.generation++;
      this.expressions?.reset();
      this.expressions = void 0;
      if (this.model) {
        this.stage.app.stage.removeChild(this.model);
        this.model.destroy({ texture: true, baseTexture: true });
      }
      this.model = void 0;
      this.source?.dispose();
      this.source = void 0;
      this.lip = new LipSync();
    }
  };

  // src/index.ts
  var stage;
  var character;
  async function dispatch(raw) {
    let id;
    let commandType;
    try {
      if (raw && typeof raw === "object" && typeof raw.id === "string" && raw.id.length <= 128) id = raw.id;
      const c = decodeCommand(raw);
      id = c.id;
      commandType = c.type;
      const p = c.payload;
      if (c.type === "runtime.initialize") {
        if (!stage) {
          stage = new PixiStage(document.body, (e) => emit("runtimeError", { message: String(e) }), p.preserveDrawingBuffer);
          character = new CharacterModel(stage);
        }
      } else {
        if (!stage || !character) throw new Error("Runtime not initialized");
        switch (c.type) {
          case "model.load":
            await character.load(p.source, p.appearanceExpressions);
            break;
          case "model.unload":
            character.unload();
            break;
          case "model.setView":
            character.view = p;
            character.fit();
            break;
          case "model.setFocus":
            character.focus = p.active ? { x: p.x, y: p.y } : void 0;
            character.model?.internalModel.focusController.focus(p.x, p.y);
            break;
          case "model.hitTest":
            for (const name of character.model?.hitTest(p.x, p.y) ?? []) emit("hitArea", { name });
            break;
          case "motion.play":
            if (!character.model || !await character.model.motion(p.group, p.index, 3)) throw new Error("Motion unavailable");
            break;
          case "expression.set":
            if (!character.expressions) throw new Error("No model");
            character.expressions.set(p.name);
            break;
          case "expression.clear":
            character.expressions?.clear();
            break;
          case "speech.setMouth":
            character.lip.openness = p.openness;
            break;
          case "speech.setSpeaking":
            character.lip.speaking = p.speaking;
            break;
          case "runtime.pause":
            stage.pause();
            break;
          case "runtime.resume":
            stage.resume();
            break;
          case "runtime.setFPS":
            stage.fps = p.fps;
            break;
          case "runtime.queryCapabilities":
            emit("capabilities", character.capabilities(), id);
            break;
        }
      }
      emit("commandCompleted", {}, id);
    } catch (error) {
      emit("runtimeError", { message: String(error), commandType: commandType ?? "invalid", fatal: commandFailureIsFatal(commandType) }, id);
    }
  }
  window.deskpetLive2D = Object.freeze({ dispatch });
  window.addEventListener("error", (e) => emit("runtimeError", { message: e.message }));
  window.addEventListener("unhandledrejection", (e) => emit("runtimeError", { message: String(e.reason) }));
  window.addEventListener("pagehide", () => {
    character?.unload();
    stage?.destroy();
  });
  document.addEventListener("pointerup", (e) => {
    for (const name of character?.model?.hitTest(e.clientX, e.clientY) ?? []) emit("hitArea", { name });
  });
  emit("runtimeReady");
})();
/*! Bundled license information:

punycode/punycode.js:
  (*! https://mths.be/punycode v1.4.1 by @mathias *)

jszip/dist/jszip.min.js:
  (*!

  JSZip v3.10.1 - A JavaScript class for generating and reading zip files
  <http://stuartk.com/jszip>

  (c) 2009-2016 Stuart Knightley <stuart [at] stuartk.com>
  Dual licenced under the MIT license or GPLv3. See https://raw.github.com/Stuk/jszip/main/LICENSE.markdown.

  JSZip uses the library pako released under the MIT license :
  https://github.com/nodeca/pako/blob/main/LICENSE
  *)

@pixi/constants/dist/esm/constants.mjs:
  (*!
   * @pixi/constants - v6.5.10
   * Compiled Thu, 06 Jul 2023 15:25:11 UTC
   *
   * @pixi/constants is licensed under the MIT License.
   * http://www.opensource.org/licenses/mit-license
   *)

@pixi/settings/dist/esm/settings.mjs:
  (*!
   * @pixi/settings - v6.5.10
   * Compiled Thu, 06 Jul 2023 15:25:11 UTC
   *
   * @pixi/settings is licensed under the MIT License.
   * http://www.opensource.org/licenses/mit-license
   *)

@pixi/utils/dist/esm/utils.mjs:
  (*!
   * @pixi/utils - v6.5.10
   * Compiled Thu, 06 Jul 2023 15:25:11 UTC
   *
   * @pixi/utils is licensed under the MIT License.
   * http://www.opensource.org/licenses/mit-license
   *)

@pixi/extensions/dist/esm/extensions.mjs:
  (*!
   * @pixi/extensions - v6.5.10
   * Compiled Thu, 06 Jul 2023 15:25:11 UTC
   *
   * @pixi/extensions is licensed under the MIT License.
   * http://www.opensource.org/licenses/mit-license
   *)
  (*! *****************************************************************************
  Copyright (c) Microsoft Corporation.

  Permission to use, copy, modify, and/or distribute this software for any
  purpose with or without fee is hereby granted.

  THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
  REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
  AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
  INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
  LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
  OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
  PERFORMANCE OF THIS SOFTWARE.
  ***************************************************************************** *)

@pixi/runner/dist/esm/runner.mjs:
  (*!
   * @pixi/runner - v6.5.10
   * Compiled Thu, 06 Jul 2023 15:25:11 UTC
   *
   * @pixi/runner is licensed under the MIT License.
   * http://www.opensource.org/licenses/mit-license
   *)

@pixi/ticker/dist/esm/ticker.mjs:
  (*!
   * @pixi/ticker - v6.5.10
   * Compiled Thu, 06 Jul 2023 15:25:11 UTC
   *
   * @pixi/ticker is licensed under the MIT License.
   * http://www.opensource.org/licenses/mit-license
   *)

@pixi/math/dist/esm/math.mjs:
  (*!
   * @pixi/math - v6.5.10
   * Compiled Thu, 06 Jul 2023 15:25:11 UTC
   *
   * @pixi/math is licensed under the MIT License.
   * http://www.opensource.org/licenses/mit-license
   *)

@pixi/core/dist/esm/core.mjs:
  (*!
   * @pixi/core - v6.5.10
   * Compiled Thu, 06 Jul 2023 15:25:11 UTC
   *
   * @pixi/core is licensed under the MIT License.
   * http://www.opensource.org/licenses/mit-license
   *)
  (*! *****************************************************************************
  Copyright (c) Microsoft Corporation.

  Permission to use, copy, modify, and/or distribute this software for any
  purpose with or without fee is hereby granted.

  THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
  REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
  AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
  INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
  LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
  OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
  PERFORMANCE OF THIS SOFTWARE.
  ***************************************************************************** *)

@pixi/display/dist/esm/display.mjs:
  (*!
   * @pixi/display - v6.5.10
   * Compiled Thu, 06 Jul 2023 15:25:11 UTC
   *
   * @pixi/display is licensed under the MIT License.
   * http://www.opensource.org/licenses/mit-license
   *)
  (*! *****************************************************************************
  Copyright (c) Microsoft Corporation.

  Permission to use, copy, modify, and/or distribute this software for any
  purpose with or without fee is hereby granted.

  THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
  REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
  AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
  INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
  LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
  OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
  PERFORMANCE OF THIS SOFTWARE.
  ***************************************************************************** *)

@pixi/app/dist/esm/app.mjs:
  (*!
   * @pixi/app - v6.5.10
   * Compiled Thu, 06 Jul 2023 15:25:11 UTC
   *
   * @pixi/app is licensed under the MIT License.
   * http://www.opensource.org/licenses/mit-license
   *)
*/
