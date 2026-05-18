"use strict";
var ChampPanels = (() => {
  // node_modules/preact/dist/preact.module.js
  var n;
  var l;
  var u;
  var t;
  var i;
  var r;
  var o;
  var e;
  var f;
  var c;
  var s;
  var a;
  var h;
  var p;
  var v;
  var y;
  var d = {};
  var w = [];
  var _ = /acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i;
  var g = Array.isArray;
  function m(n3, l5) {
    for (var u3 in l5) n3[u3] = l5[u3];
    return n3;
  }
  function b(n3) {
    n3 && n3.parentNode && n3.parentNode.removeChild(n3);
  }
  function k(l5, u3, t4) {
    var i4, r4, o4, e4 = {};
    for (o4 in u3) "key" == o4 ? i4 = u3[o4] : "ref" == o4 ? r4 = u3[o4] : e4[o4] = u3[o4];
    if (arguments.length > 2 && (e4.children = arguments.length > 3 ? n.call(arguments, 2) : t4), "function" == typeof l5 && null != l5.defaultProps) for (o4 in l5.defaultProps) void 0 === e4[o4] && (e4[o4] = l5.defaultProps[o4]);
    return x(l5, e4, i4, r4, null);
  }
  function x(n3, t4, i4, r4, o4) {
    var e4 = { type: n3, props: t4, key: i4, ref: r4, __k: null, __: null, __b: 0, __e: null, __c: null, constructor: void 0, __v: null == o4 ? ++u : o4, __i: -1, __u: 0 };
    return null == o4 && null != l.vnode && l.vnode(e4), e4;
  }
  function S(n3) {
    return n3.children;
  }
  function C(n3, l5) {
    this.props = n3, this.context = l5;
  }
  function $(n3, l5) {
    if (null == l5) return n3.__ ? $(n3.__, n3.__i + 1) : null;
    for (var u3; l5 < n3.__k.length; l5++) if (null != (u3 = n3.__k[l5]) && null != u3.__e) return u3.__e;
    return "function" == typeof n3.type ? $(n3) : null;
  }
  function I(n3) {
    if (n3.__P && n3.__d) {
      var u3 = n3.__v, t4 = u3.__e, i4 = [], r4 = [], o4 = m({}, u3);
      o4.__v = u3.__v + 1, l.vnode && l.vnode(o4), q(n3.__P, o4, u3, n3.__n, n3.__P.namespaceURI, 32 & u3.__u ? [t4] : null, i4, null == t4 ? $(u3) : t4, !!(32 & u3.__u), r4), o4.__v = u3.__v, o4.__.__k[o4.__i] = o4, D(i4, o4, r4), u3.__e = u3.__ = null, o4.__e != t4 && P(o4);
    }
  }
  function P(n3) {
    if (null != (n3 = n3.__) && null != n3.__c) return n3.__e = n3.__c.base = null, n3.__k.some(function(l5) {
      if (null != l5 && null != l5.__e) return n3.__e = n3.__c.base = l5.__e;
    }), P(n3);
  }
  function A(n3) {
    (!n3.__d && (n3.__d = true) && i.push(n3) && !H.__r++ || r != l.debounceRendering) && ((r = l.debounceRendering) || o)(H);
  }
  function H() {
    try {
      for (var n3, l5 = 1; i.length; ) i.length > l5 && i.sort(e), n3 = i.shift(), l5 = i.length, I(n3);
    } finally {
      i.length = H.__r = 0;
    }
  }
  function L(n3, l5, u3, t4, i4, r4, o4, e4, f4, c4, s5) {
    var a4, h5, p5, v5, y4, _3, g3, m4 = t4 && t4.__k || w, b3 = l5.length;
    for (f4 = T(u3, l5, m4, f4, b3), a4 = 0; a4 < b3; a4++) null != (p5 = u3.__k[a4]) && (h5 = -1 != p5.__i && m4[p5.__i] || d, p5.__i = a4, _3 = q(n3, p5, h5, i4, r4, o4, e4, f4, c4, s5), v5 = p5.__e, p5.ref && h5.ref != p5.ref && (h5.ref && J(h5.ref, null, p5), s5.push(p5.ref, p5.__c || v5, p5)), null == y4 && null != v5 && (y4 = v5), (g3 = !!(4 & p5.__u)) || h5.__k === p5.__k ? (f4 = j(p5, f4, n3, g3), g3 && h5.__e && (h5.__e = null)) : "function" == typeof p5.type && void 0 !== _3 ? f4 = _3 : v5 && (f4 = v5.nextSibling), p5.__u &= -7);
    return u3.__e = y4, f4;
  }
  function T(n3, l5, u3, t4, i4) {
    var r4, o4, e4, f4, c4, s5 = u3.length, a4 = s5, h5 = 0;
    for (n3.__k = new Array(i4), r4 = 0; r4 < i4; r4++) null != (o4 = l5[r4]) && "boolean" != typeof o4 && "function" != typeof o4 ? ("string" == typeof o4 || "number" == typeof o4 || "bigint" == typeof o4 || o4.constructor == String ? o4 = n3.__k[r4] = x(null, o4, null, null, null) : g(o4) ? o4 = n3.__k[r4] = x(S, { children: o4 }, null, null, null) : void 0 === o4.constructor && o4.__b > 0 ? o4 = n3.__k[r4] = x(o4.type, o4.props, o4.key, o4.ref ? o4.ref : null, o4.__v) : n3.__k[r4] = o4, f4 = r4 + h5, o4.__ = n3, o4.__b = n3.__b + 1, e4 = null, -1 != (c4 = o4.__i = O(o4, u3, f4, a4)) && (a4--, (e4 = u3[c4]) && (e4.__u |= 2)), null == e4 || null == e4.__v ? (-1 == c4 && (i4 > s5 ? h5-- : i4 < s5 && h5++), "function" != typeof o4.type && (o4.__u |= 4)) : c4 != f4 && (c4 == f4 - 1 ? h5-- : c4 == f4 + 1 ? h5++ : (c4 > f4 ? h5-- : h5++, o4.__u |= 4))) : n3.__k[r4] = null;
    if (a4) for (r4 = 0; r4 < s5; r4++) null != (e4 = u3[r4]) && 0 == (2 & e4.__u) && (e4.__e == t4 && (t4 = $(e4)), K(e4, e4));
    return t4;
  }
  function j(n3, l5, u3, t4) {
    var i4, r4;
    if ("function" == typeof n3.type) {
      for (i4 = n3.__k, r4 = 0; i4 && r4 < i4.length; r4++) i4[r4] && (i4[r4].__ = n3, l5 = j(i4[r4], l5, u3, t4));
      return l5;
    }
    n3.__e != l5 && (t4 && (l5 && n3.type && !l5.parentNode && (l5 = $(n3)), u3.insertBefore(n3.__e, l5 || null)), l5 = n3.__e);
    do {
      l5 = l5 && l5.nextSibling;
    } while (null != l5 && 8 == l5.nodeType);
    return l5;
  }
  function O(n3, l5, u3, t4) {
    var i4, r4, o4, e4 = n3.key, f4 = n3.type, c4 = l5[u3], s5 = null != c4 && 0 == (2 & c4.__u);
    if (null === c4 && null == e4 || s5 && e4 == c4.key && f4 == c4.type) return u3;
    if (t4 > (s5 ? 1 : 0)) {
      for (i4 = u3 - 1, r4 = u3 + 1; i4 >= 0 || r4 < l5.length; ) if (null != (c4 = l5[o4 = i4 >= 0 ? i4-- : r4++]) && 0 == (2 & c4.__u) && e4 == c4.key && f4 == c4.type) return o4;
    }
    return -1;
  }
  function z(n3, l5, u3) {
    "-" == l5[0] ? n3.setProperty(l5, null == u3 ? "" : u3) : n3[l5] = null == u3 ? "" : "number" != typeof u3 || _.test(l5) ? u3 : u3 + "px";
  }
  function N(n3, l5, u3, t4, i4) {
    var r4, o4;
    n: if ("style" == l5) if ("string" == typeof u3) n3.style.cssText = u3;
    else {
      if ("string" == typeof t4 && (n3.style.cssText = t4 = ""), t4) for (l5 in t4) u3 && l5 in u3 || z(n3.style, l5, "");
      if (u3) for (l5 in u3) t4 && u3[l5] == t4[l5] || z(n3.style, l5, u3[l5]);
    }
    else if ("o" == l5[0] && "n" == l5[1]) r4 = l5 != (l5 = l5.replace(a, "$1")), o4 = l5.toLowerCase(), l5 = o4 in n3 || "onFocusOut" == l5 || "onFocusIn" == l5 ? o4.slice(2) : l5.slice(2), n3.l || (n3.l = {}), n3.l[l5 + r4] = u3, u3 ? t4 ? u3[s] = t4[s] : (u3[s] = h, n3.addEventListener(l5, r4 ? v : p, r4)) : n3.removeEventListener(l5, r4 ? v : p, r4);
    else {
      if ("http://www.w3.org/2000/svg" == i4) l5 = l5.replace(/xlink(H|:h)/, "h").replace(/sName$/, "s");
      else if ("width" != l5 && "height" != l5 && "href" != l5 && "list" != l5 && "form" != l5 && "tabIndex" != l5 && "download" != l5 && "rowSpan" != l5 && "colSpan" != l5 && "role" != l5 && "popover" != l5 && l5 in n3) try {
        n3[l5] = null == u3 ? "" : u3;
        break n;
      } catch (n4) {
      }
      "function" == typeof u3 || (null == u3 || false === u3 && "-" != l5[4] ? n3.removeAttribute(l5) : n3.setAttribute(l5, "popover" == l5 && 1 == u3 ? "" : u3));
    }
  }
  function V(n3) {
    return function(u3) {
      if (this.l) {
        var t4 = this.l[u3.type + n3];
        if (null == u3[c]) u3[c] = h++;
        else if (u3[c] < t4[s]) return;
        return t4(l.event ? l.event(u3) : u3);
      }
    };
  }
  function q(n3, u3, t4, i4, r4, o4, e4, f4, c4, s5) {
    var a4, h5, p5, v5, y4, d5, _3, k3, x3, M, $2, I2, P2, A3, H2, T3 = u3.type;
    if (void 0 !== u3.constructor) return null;
    128 & t4.__u && (c4 = !!(32 & t4.__u), o4 = [f4 = u3.__e = t4.__e]), (a4 = l.__b) && a4(u3);
    n: if ("function" == typeof T3) try {
      if (k3 = u3.props, x3 = T3.prototype && T3.prototype.render, M = (a4 = T3.contextType) && i4[a4.__c], $2 = a4 ? M ? M.props.value : a4.__ : i4, t4.__c ? _3 = (h5 = u3.__c = t4.__c).__ = h5.__E : (x3 ? u3.__c = h5 = new T3(k3, $2) : (u3.__c = h5 = new C(k3, $2), h5.constructor = T3, h5.render = Q), M && M.sub(h5), h5.state || (h5.state = {}), h5.__n = i4, p5 = h5.__d = true, h5.__h = [], h5._sb = []), x3 && null == h5.__s && (h5.__s = h5.state), x3 && null != T3.getDerivedStateFromProps && (h5.__s == h5.state && (h5.__s = m({}, h5.__s)), m(h5.__s, T3.getDerivedStateFromProps(k3, h5.__s))), v5 = h5.props, y4 = h5.state, h5.__v = u3, p5) x3 && null == T3.getDerivedStateFromProps && null != h5.componentWillMount && h5.componentWillMount(), x3 && null != h5.componentDidMount && h5.__h.push(h5.componentDidMount);
      else {
        if (x3 && null == T3.getDerivedStateFromProps && k3 !== v5 && null != h5.componentWillReceiveProps && h5.componentWillReceiveProps(k3, $2), u3.__v == t4.__v || !h5.__e && null != h5.shouldComponentUpdate && false === h5.shouldComponentUpdate(k3, h5.__s, $2)) {
          u3.__v != t4.__v && (h5.props = k3, h5.state = h5.__s, h5.__d = false), u3.__e = t4.__e, u3.__k = t4.__k, u3.__k.some(function(n4) {
            n4 && (n4.__ = u3);
          }), w.push.apply(h5.__h, h5._sb), h5._sb = [], h5.__h.length && e4.push(h5);
          break n;
        }
        null != h5.componentWillUpdate && h5.componentWillUpdate(k3, h5.__s, $2), x3 && null != h5.componentDidUpdate && h5.__h.push(function() {
          h5.componentDidUpdate(v5, y4, d5);
        });
      }
      if (h5.context = $2, h5.props = k3, h5.__P = n3, h5.__e = false, I2 = l.__r, P2 = 0, x3) h5.state = h5.__s, h5.__d = false, I2 && I2(u3), a4 = h5.render(h5.props, h5.state, h5.context), w.push.apply(h5.__h, h5._sb), h5._sb = [];
      else do {
        h5.__d = false, I2 && I2(u3), a4 = h5.render(h5.props, h5.state, h5.context), h5.state = h5.__s;
      } while (h5.__d && ++P2 < 25);
      h5.state = h5.__s, null != h5.getChildContext && (i4 = m(m({}, i4), h5.getChildContext())), x3 && !p5 && null != h5.getSnapshotBeforeUpdate && (d5 = h5.getSnapshotBeforeUpdate(v5, y4)), A3 = null != a4 && a4.type === S && null == a4.key ? E(a4.props.children) : a4, f4 = L(n3, g(A3) ? A3 : [A3], u3, t4, i4, r4, o4, e4, f4, c4, s5), h5.base = u3.__e, u3.__u &= -161, h5.__h.length && e4.push(h5), _3 && (h5.__E = h5.__ = null);
    } catch (n4) {
      if (u3.__v = null, c4 || null != o4) if (n4.then) {
        for (u3.__u |= c4 ? 160 : 128; f4 && 8 == f4.nodeType && f4.nextSibling; ) f4 = f4.nextSibling;
        o4[o4.indexOf(f4)] = null, u3.__e = f4;
      } else {
        for (H2 = o4.length; H2--; ) b(o4[H2]);
        B(u3);
      }
      else u3.__e = t4.__e, u3.__k = t4.__k, n4.then || B(u3);
      l.__e(n4, u3, t4);
    }
    else null == o4 && u3.__v == t4.__v ? (u3.__k = t4.__k, u3.__e = t4.__e) : f4 = u3.__e = G(t4.__e, u3, t4, i4, r4, o4, e4, c4, s5);
    return (a4 = l.diffed) && a4(u3), 128 & u3.__u ? void 0 : f4;
  }
  function B(n3) {
    n3 && (n3.__c && (n3.__c.__e = true), n3.__k && n3.__k.some(B));
  }
  function D(n3, u3, t4) {
    for (var i4 = 0; i4 < t4.length; i4++) J(t4[i4], t4[++i4], t4[++i4]);
    l.__c && l.__c(u3, n3), n3.some(function(u4) {
      try {
        n3 = u4.__h, u4.__h = [], n3.some(function(n4) {
          n4.call(u4);
        });
      } catch (n4) {
        l.__e(n4, u4.__v);
      }
    });
  }
  function E(n3) {
    return "object" != typeof n3 || null == n3 || n3.__b > 0 ? n3 : g(n3) ? n3.map(E) : m({}, n3);
  }
  function G(u3, t4, i4, r4, o4, e4, f4, c4, s5) {
    var a4, h5, p5, v5, y4, w4, _3, m4 = i4.props || d, k3 = t4.props, x3 = t4.type;
    if ("svg" == x3 ? o4 = "http://www.w3.org/2000/svg" : "math" == x3 ? o4 = "http://www.w3.org/1998/Math/MathML" : o4 || (o4 = "http://www.w3.org/1999/xhtml"), null != e4) {
      for (a4 = 0; a4 < e4.length; a4++) if ((y4 = e4[a4]) && "setAttribute" in y4 == !!x3 && (x3 ? y4.localName == x3 : 3 == y4.nodeType)) {
        u3 = y4, e4[a4] = null;
        break;
      }
    }
    if (null == u3) {
      if (null == x3) return document.createTextNode(k3);
      u3 = document.createElementNS(o4, x3, k3.is && k3), c4 && (l.__m && l.__m(t4, e4), c4 = false), e4 = null;
    }
    if (null == x3) m4 === k3 || c4 && u3.data == k3 || (u3.data = k3);
    else {
      if (e4 = e4 && n.call(u3.childNodes), !c4 && null != e4) for (m4 = {}, a4 = 0; a4 < u3.attributes.length; a4++) m4[(y4 = u3.attributes[a4]).name] = y4.value;
      for (a4 in m4) y4 = m4[a4], "dangerouslySetInnerHTML" == a4 ? p5 = y4 : "children" == a4 || a4 in k3 || "value" == a4 && "defaultValue" in k3 || "checked" == a4 && "defaultChecked" in k3 || N(u3, a4, null, y4, o4);
      for (a4 in k3) y4 = k3[a4], "children" == a4 ? v5 = y4 : "dangerouslySetInnerHTML" == a4 ? h5 = y4 : "value" == a4 ? w4 = y4 : "checked" == a4 ? _3 = y4 : c4 && "function" != typeof y4 || m4[a4] === y4 || N(u3, a4, y4, m4[a4], o4);
      if (h5) c4 || p5 && (h5.__html == p5.__html || h5.__html == u3.innerHTML) || (u3.innerHTML = h5.__html), t4.__k = [];
      else if (p5 && (u3.innerHTML = ""), L("template" == t4.type ? u3.content : u3, g(v5) ? v5 : [v5], t4, i4, r4, "foreignObject" == x3 ? "http://www.w3.org/1999/xhtml" : o4, e4, f4, e4 ? e4[0] : i4.__k && $(i4, 0), c4, s5), null != e4) for (a4 = e4.length; a4--; ) b(e4[a4]);
      c4 || (a4 = "value", "progress" == x3 && null == w4 ? u3.removeAttribute("value") : null != w4 && (w4 !== u3[a4] || "progress" == x3 && !w4 || "option" == x3 && w4 != m4[a4]) && N(u3, a4, w4, m4[a4], o4), a4 = "checked", null != _3 && _3 != u3[a4] && N(u3, a4, _3, m4[a4], o4));
    }
    return u3;
  }
  function J(n3, u3, t4) {
    try {
      if ("function" == typeof n3) {
        var i4 = "function" == typeof n3.__u;
        i4 && n3.__u(), i4 && null == u3 || (n3.__u = n3(u3));
      } else n3.current = u3;
    } catch (n4) {
      l.__e(n4, t4);
    }
  }
  function K(n3, u3, t4) {
    var i4, r4;
    if (l.unmount && l.unmount(n3), (i4 = n3.ref) && (i4.current && i4.current != n3.__e || J(i4, null, u3)), null != (i4 = n3.__c)) {
      if (i4.componentWillUnmount) try {
        i4.componentWillUnmount();
      } catch (n4) {
        l.__e(n4, u3);
      }
      i4.base = i4.__P = null;
    }
    if (i4 = n3.__k) for (r4 = 0; r4 < i4.length; r4++) i4[r4] && K(i4[r4], u3, t4 || "function" != typeof n3.type);
    t4 || b(n3.__e), n3.__c = n3.__ = n3.__e = void 0;
  }
  function Q(n3, l5, u3) {
    return this.constructor(n3, u3);
  }
  function R(u3, t4, i4) {
    var r4, o4, e4, f4;
    t4 == document && (t4 = document.documentElement), l.__ && l.__(u3, t4), o4 = (r4 = "function" == typeof i4) ? null : i4 && i4.__k || t4.__k, e4 = [], f4 = [], q(t4, u3 = (!r4 && i4 || t4).__k = k(S, null, [u3]), o4 || d, d, t4.namespaceURI, !r4 && i4 ? [i4] : o4 ? null : t4.firstChild ? n.call(t4.childNodes) : null, e4, !r4 && i4 ? i4 : o4 ? o4.__e : t4.firstChild, r4, f4), D(e4, u3, f4);
  }
  n = w.slice, l = { __e: function(n3, l5, u3, t4) {
    for (var i4, r4, o4; l5 = l5.__; ) if ((i4 = l5.__c) && !i4.__) try {
      if ((r4 = i4.constructor) && null != r4.getDerivedStateFromError && (i4.setState(r4.getDerivedStateFromError(n3)), o4 = i4.__d), null != i4.componentDidCatch && (i4.componentDidCatch(n3, t4 || {}), o4 = i4.__d), o4) return i4.__E = i4;
    } catch (l6) {
      n3 = l6;
    }
    throw n3;
  } }, u = 0, t = function(n3) {
    return null != n3 && void 0 === n3.constructor;
  }, C.prototype.setState = function(n3, l5) {
    var u3;
    u3 = null != this.__s && this.__s != this.state ? this.__s : this.__s = m({}, this.state), "function" == typeof n3 && (n3 = n3(m({}, u3), this.props)), n3 && m(u3, n3), null != n3 && this.__v && (l5 && this._sb.push(l5), A(this));
  }, C.prototype.forceUpdate = function(n3) {
    this.__v && (this.__e = true, n3 && this.__h.push(n3), A(this));
  }, C.prototype.render = S, i = [], o = "function" == typeof Promise ? Promise.prototype.then.bind(Promise.resolve()) : setTimeout, e = function(n3, l5) {
    return n3.__v.__b - l5.__v.__b;
  }, H.__r = 0, f = Math.random().toString(8), c = "__d" + f, s = "__a" + f, a = /(PointerCapture)$|Capture$/i, h = 0, p = V(false), v = V(true), y = 0;

  // node_modules/preact/hooks/dist/hooks.module.js
  var t2;
  var r2;
  var u2;
  var i2;
  var o2 = 0;
  var f2 = [];
  var c2 = l;
  var e2 = c2.__b;
  var a2 = c2.__r;
  var v2 = c2.diffed;
  var l2 = c2.__c;
  var m2 = c2.unmount;
  var s2 = c2.__;
  function p2(n3, t4) {
    c2.__h && c2.__h(r2, n3, o2 || t4), o2 = 0;
    var u3 = r2.__H || (r2.__H = { __: [], __h: [] });
    return n3 >= u3.__.length && u3.__.push({}), u3.__[n3];
  }
  function d2(n3) {
    return o2 = 1, h2(D2, n3);
  }
  function h2(n3, u3, i4) {
    var o4 = p2(t2++, 2);
    if (o4.t = n3, !o4.__c && (o4.__ = [i4 ? i4(u3) : D2(void 0, u3), function(n4) {
      var t4 = o4.__N ? o4.__N[0] : o4.__[0], r4 = o4.t(t4, n4);
      t4 !== r4 && (o4.__N = [r4, o4.__[1]], o4.__c.setState({}));
    }], o4.__c = r2, !r2.__f)) {
      var f4 = function(n4, t4, r4) {
        if (!o4.__c.__H) return true;
        var u4 = o4.__c.__H.__.filter(function(n5) {
          return n5.__c;
        });
        if (u4.every(function(n5) {
          return !n5.__N;
        })) return !c4 || c4.call(this, n4, t4, r4);
        var i5 = o4.__c.props !== n4;
        return u4.some(function(n5) {
          if (n5.__N) {
            var t5 = n5.__[0];
            n5.__ = n5.__N, n5.__N = void 0, t5 !== n5.__[0] && (i5 = true);
          }
        }), c4 && c4.call(this, n4, t4, r4) || i5;
      };
      r2.__f = true;
      var c4 = r2.shouldComponentUpdate, e4 = r2.componentWillUpdate;
      r2.componentWillUpdate = function(n4, t4, r4) {
        if (this.__e) {
          var u4 = c4;
          c4 = void 0, f4(n4, t4, r4), c4 = u4;
        }
        e4 && e4.call(this, n4, t4, r4);
      }, r2.shouldComponentUpdate = f4;
    }
    return o4.__N || o4.__;
  }
  function y2(n3, u3) {
    var i4 = p2(t2++, 3);
    !c2.__s && C2(i4.__H, u3) && (i4.__ = n3, i4.u = u3, r2.__H.__h.push(i4));
  }
  function T2(n3, r4) {
    var u3 = p2(t2++, 7);
    return C2(u3.__H, r4) && (u3.__ = n3(), u3.__H = r4, u3.__h = n3), u3.__;
  }
  function j2() {
    for (var n3; n3 = f2.shift(); ) {
      var t4 = n3.__H;
      if (n3.__P && t4) try {
        t4.__h.some(z2), t4.__h.some(B2), t4.__h = [];
      } catch (r4) {
        t4.__h = [], c2.__e(r4, n3.__v);
      }
    }
  }
  c2.__b = function(n3) {
    r2 = null, e2 && e2(n3);
  }, c2.__ = function(n3, t4) {
    n3 && t4.__k && t4.__k.__m && (n3.__m = t4.__k.__m), s2 && s2(n3, t4);
  }, c2.__r = function(n3) {
    a2 && a2(n3), t2 = 0;
    var i4 = (r2 = n3.__c).__H;
    i4 && (u2 === r2 ? (i4.__h = [], r2.__h = [], i4.__.some(function(n4) {
      n4.__N && (n4.__ = n4.__N), n4.u = n4.__N = void 0;
    })) : (i4.__h.some(z2), i4.__h.some(B2), i4.__h = [], t2 = 0)), u2 = r2;
  }, c2.diffed = function(n3) {
    v2 && v2(n3);
    var t4 = n3.__c;
    t4 && t4.__H && (t4.__H.__h.length && (1 !== f2.push(t4) && i2 === c2.requestAnimationFrame || ((i2 = c2.requestAnimationFrame) || w2)(j2)), t4.__H.__.some(function(n4) {
      n4.u && (n4.__H = n4.u), n4.u = void 0;
    })), u2 = r2 = null;
  }, c2.__c = function(n3, t4) {
    t4.some(function(n4) {
      try {
        n4.__h.some(z2), n4.__h = n4.__h.filter(function(n5) {
          return !n5.__ || B2(n5);
        });
      } catch (r4) {
        t4.some(function(n5) {
          n5.__h && (n5.__h = []);
        }), t4 = [], c2.__e(r4, n4.__v);
      }
    }), l2 && l2(n3, t4);
  }, c2.unmount = function(n3) {
    m2 && m2(n3);
    var t4, r4 = n3.__c;
    r4 && r4.__H && (r4.__H.__.some(function(n4) {
      try {
        z2(n4);
      } catch (n5) {
        t4 = n5;
      }
    }), r4.__H = void 0, t4 && c2.__e(t4, r4.__v));
  };
  var k2 = "function" == typeof requestAnimationFrame;
  function w2(n3) {
    var t4, r4 = function() {
      clearTimeout(u3), k2 && cancelAnimationFrame(t4), setTimeout(n3);
    }, u3 = setTimeout(r4, 35);
    k2 && (t4 = requestAnimationFrame(r4));
  }
  function z2(n3) {
    var t4 = r2, u3 = n3.__c;
    "function" == typeof u3 && (n3.__c = void 0, u3()), r2 = t4;
  }
  function B2(n3) {
    var t4 = r2;
    n3.__c = n3.__(), r2 = t4;
  }
  function C2(n3, t4) {
    return !n3 || n3.length !== t4.length || t4.some(function(t5, r4) {
      return t5 !== n3[r4];
    });
  }
  function D2(n3, t4) {
    return "function" == typeof t4 ? t4(n3) : t4;
  }

  // node_modules/@preact/signals-core/dist/signals-core.module.js
  var i3 = Symbol.for("preact-signals");
  function t3() {
    if (!(s3 > 1)) {
      var i4, t4 = false;
      !function() {
        var i5 = c3;
        c3 = void 0;
        while (void 0 !== i5) {
          if (i5.S.v === i5.v) i5.S.i = i5.i;
          i5 = i5.o;
        }
      }();
      while (void 0 !== h3) {
        var n3 = h3;
        h3 = void 0;
        v3++;
        while (void 0 !== n3) {
          var r4 = n3.u;
          n3.u = void 0;
          n3.f &= -3;
          if (!(8 & n3.f) && w3(n3)) try {
            n3.c();
          } catch (n4) {
            if (!t4) {
              i4 = n4;
              t4 = true;
            }
          }
          n3 = r4;
        }
      }
      v3 = 0;
      s3--;
      if (t4) throw i4;
    } else s3--;
  }
  var r3 = void 0;
  function o3(i4) {
    var t4 = r3;
    r3 = void 0;
    try {
      return i4();
    } finally {
      r3 = t4;
    }
  }
  var f3;
  var h3 = void 0;
  var s3 = 0;
  var v3 = 0;
  var e3 = 0;
  var c3 = void 0;
  var d3 = 0;
  function a3(i4) {
    if (void 0 !== r3) {
      var t4 = i4.n;
      if (void 0 === t4 || t4.t !== r3) {
        t4 = { i: 0, S: i4, p: r3.s, n: void 0, t: r3, e: void 0, x: void 0, r: t4 };
        if (void 0 !== r3.s) r3.s.n = t4;
        r3.s = t4;
        i4.n = t4;
        if (32 & r3.f) i4.S(t4);
        return t4;
      } else if (-1 === t4.i) {
        t4.i = 0;
        if (void 0 !== t4.n) {
          t4.n.p = t4.p;
          if (void 0 !== t4.p) t4.p.n = t4.n;
          t4.p = r3.s;
          t4.n = void 0;
          r3.s.n = t4;
          r3.s = t4;
        }
        return t4;
      }
    }
  }
  function l3(i4, t4) {
    this.v = i4;
    this.i = 0;
    this.n = void 0;
    this.t = void 0;
    this.l = 0;
    this.W = null == t4 ? void 0 : t4.watched;
    this.Z = null == t4 ? void 0 : t4.unwatched;
    this.name = null == t4 ? void 0 : t4.name;
  }
  l3.prototype.brand = i3;
  l3.prototype.h = function() {
    return true;
  };
  l3.prototype.S = function(i4) {
    var t4 = this, n3 = this.t;
    if (n3 !== i4 && void 0 === i4.e) {
      i4.x = n3;
      this.t = i4;
      if (void 0 !== n3) n3.e = i4;
      else o3(function() {
        var i5;
        null == (i5 = t4.W) || i5.call(t4);
      });
    }
  };
  l3.prototype.U = function(i4) {
    var t4 = this;
    if (void 0 !== this.t) {
      var n3 = i4.e, r4 = i4.x;
      if (void 0 !== n3) {
        n3.x = r4;
        i4.e = void 0;
      }
      if (void 0 !== r4) {
        r4.e = n3;
        i4.x = void 0;
      }
      if (i4 === this.t) {
        this.t = r4;
        if (void 0 === r4) o3(function() {
          var i5;
          null == (i5 = t4.Z) || i5.call(t4);
        });
      }
    }
  };
  l3.prototype.subscribe = function(i4) {
    var t4 = this;
    return j3(function() {
      var n3 = t4.value, o4 = r3;
      r3 = void 0;
      try {
        i4(n3);
      } finally {
        r3 = o4;
      }
    }, { name: "sub" });
  };
  l3.prototype.valueOf = function() {
    return this.value;
  };
  l3.prototype.toString = function() {
    return this.value + "";
  };
  l3.prototype.toJSON = function() {
    return this.value;
  };
  l3.prototype.peek = function() {
    var i4 = this;
    return o3(function() {
      return i4.value;
    });
  };
  Object.defineProperty(l3.prototype, "value", { get: function() {
    var i4 = a3(this);
    if (void 0 !== i4) i4.i = this.i;
    return this.v;
  }, set: function(i4) {
    if (i4 !== this.v) {
      if (v3 > 100) throw new Error("Cycle detected");
      !function(i5) {
        if (0 !== s3 && 0 === v3) {
          if (i5.l !== e3) {
            i5.l = e3;
            c3 = { S: i5, v: i5.v, i: i5.i, o: c3 };
          }
        }
      }(this);
      this.v = i4;
      this.i++;
      d3++;
      s3++;
      try {
        for (var n3 = this.t; void 0 !== n3; n3 = n3.x) n3.t.N();
      } finally {
        t3();
      }
    }
  } });
  function y3(i4, t4) {
    return new l3(i4, t4);
  }
  function w3(i4) {
    for (var t4 = i4.s; void 0 !== t4; t4 = t4.n) if (t4.S.i !== t4.i || !t4.S.h() || t4.S.i !== t4.i) return true;
    return false;
  }
  function _2(i4) {
    for (var t4 = i4.s; void 0 !== t4; t4 = t4.n) {
      var n3 = t4.S.n;
      if (void 0 !== n3) t4.r = n3;
      t4.S.n = t4;
      t4.i = -1;
      if (void 0 === t4.n) {
        i4.s = t4;
        break;
      }
    }
  }
  function b2(i4) {
    var t4 = i4.s, n3 = void 0;
    while (void 0 !== t4) {
      var r4 = t4.p;
      if (-1 === t4.i) {
        t4.S.U(t4);
        if (void 0 !== r4) r4.n = t4.n;
        if (void 0 !== t4.n) t4.n.p = r4;
      } else n3 = t4;
      t4.S.n = t4.r;
      if (void 0 !== t4.r) t4.r = void 0;
      t4 = r4;
    }
    i4.s = n3;
  }
  function p3(i4, t4) {
    l3.call(this, void 0);
    this.x = i4;
    this.s = void 0;
    this.g = d3 - 1;
    this.f = 4;
    this.W = null == t4 ? void 0 : t4.watched;
    this.Z = null == t4 ? void 0 : t4.unwatched;
    this.name = null == t4 ? void 0 : t4.name;
  }
  p3.prototype = new l3();
  p3.prototype.h = function() {
    this.f &= -3;
    if (1 & this.f) return false;
    if (32 == (36 & this.f)) return true;
    this.f &= -5;
    if (this.g === d3) return true;
    this.g = d3;
    this.f |= 1;
    if (this.i > 0 && !w3(this)) {
      this.f &= -2;
      return true;
    }
    var i4 = r3;
    try {
      _2(this);
      r3 = this;
      var t4 = this.x();
      if (16 & this.f || this.v !== t4 || 0 === this.i) {
        this.v = t4;
        this.f &= -17;
        this.i++;
      }
    } catch (i5) {
      this.v = i5;
      this.f |= 16;
      this.i++;
    }
    r3 = i4;
    b2(this);
    this.f &= -2;
    return true;
  };
  p3.prototype.S = function(i4) {
    if (void 0 === this.t) {
      this.f |= 36;
      for (var t4 = this.s; void 0 !== t4; t4 = t4.n) t4.S.S(t4);
    }
    l3.prototype.S.call(this, i4);
  };
  p3.prototype.U = function(i4) {
    if (void 0 !== this.t) {
      l3.prototype.U.call(this, i4);
      if (void 0 === this.t) {
        this.f &= -33;
        for (var t4 = this.s; void 0 !== t4; t4 = t4.n) t4.S.U(t4);
      }
    }
  };
  p3.prototype.N = function() {
    if (!(2 & this.f)) {
      this.f |= 6;
      for (var i4 = this.t; void 0 !== i4; i4 = i4.x) i4.t.N();
    }
  };
  Object.defineProperty(p3.prototype, "value", { get: function() {
    if (1 & this.f) throw new Error("Cycle detected");
    var i4 = a3(this);
    this.h();
    if (void 0 !== i4) i4.i = this.i;
    if (16 & this.f) throw this.v;
    return this.v;
  } });
  function g2(i4, t4) {
    return new p3(i4, t4);
  }
  function S2(i4) {
    var n3 = i4.m;
    i4.m = void 0;
    if ("function" == typeof n3) {
      s3++;
      var o4 = r3;
      r3 = void 0;
      try {
        n3();
      } catch (t4) {
        i4.f &= -2;
        i4.f |= 8;
        m3(i4);
        throw t4;
      } finally {
        r3 = o4;
        t3();
      }
    }
  }
  function m3(i4) {
    for (var t4 = i4.s; void 0 !== t4; t4 = t4.n) t4.S.U(t4);
    i4.x = void 0;
    i4.s = void 0;
    S2(i4);
  }
  function x2(i4) {
    if (r3 !== this) throw new Error("Out-of-order effect");
    b2(this);
    r3 = i4;
    this.f &= -2;
    if (8 & this.f) m3(this);
    t3();
  }
  function E2(i4, t4) {
    this.x = i4;
    this.m = void 0;
    this.s = void 0;
    this.u = void 0;
    this.f = 32;
    this.name = null == t4 ? void 0 : t4.name;
    if (f3) f3.push(this);
  }
  E2.prototype.c = function() {
    var i4 = this.S();
    try {
      if (8 & this.f) return;
      if (void 0 === this.x) return;
      var t4 = this.x();
      if ("function" == typeof t4) this.m = t4;
    } finally {
      i4();
    }
  };
  E2.prototype.S = function() {
    if (1 & this.f) throw new Error("Cycle detected");
    this.f |= 1;
    this.f &= -9;
    S2(this);
    _2(this);
    s3++;
    var i4 = r3;
    r3 = this;
    return x2.bind(this, i4);
  };
  E2.prototype.N = function() {
    if (!(2 & this.f)) {
      this.f |= 2;
      this.u = h3;
      h3 = this;
    }
  };
  E2.prototype.d = function() {
    this.f |= 8;
    if (!(1 & this.f)) m3(this);
  };
  E2.prototype.dispose = function() {
    this.d();
  };
  function j3(i4, t4) {
    var n3 = new E2(i4, t4);
    try {
      n3.c();
    } catch (i5) {
      n3.d();
      throw i5;
    }
    var r4 = n3.d.bind(n3);
    r4[Symbol.dispose] = r4;
    return r4;
  }

  // node_modules/@preact/signals/dist/signals.module.js
  var v4;
  var s4;
  function l4(i4, n3) {
    l[i4] = n3.bind(null, l[i4] || function() {
    });
  }
  function d4(i4) {
    if (s4) {
      var r4 = s4;
      s4 = void 0;
      r4();
    }
    s4 = i4 && i4.S();
  }
  function h4(i4) {
    var r4 = this, f4 = i4.data, o4 = useSignal(f4);
    o4.value = f4;
    var e4 = T2(function() {
      var i5 = r4.__v;
      while (i5 = i5.__) if (i5.__c) {
        i5.__c.__$f |= 4;
        break;
      }
      r4.__$u.c = function() {
        var i6, t4 = r4.__$u.S(), f5 = e4.value;
        t4();
        if (t(f5) || 3 !== (null == (i6 = r4.base) ? void 0 : i6.nodeType)) {
          r4.__$f |= 1;
          r4.setState({});
        } else r4.base.data = f5;
      };
      return g2(function() {
        var i6 = o4.value.value;
        return 0 === i6 ? 0 : true === i6 ? "" : i6 || "";
      });
    }, []);
    return e4.value;
  }
  h4.displayName = "_st";
  Object.defineProperties(l3.prototype, { constructor: { configurable: true, value: void 0 }, type: { configurable: true, value: h4 }, props: { configurable: true, get: function() {
    return { data: this };
  } }, __b: { configurable: true, value: 1 } });
  l4("__b", function(i4, r4) {
    if ("string" == typeof r4.type) {
      var n3, t4 = r4.props;
      for (var f4 in t4) if ("children" !== f4) {
        var o4 = t4[f4];
        if (o4 instanceof l3) {
          if (!n3) r4.__np = n3 = {};
          n3[f4] = o4;
          t4[f4] = o4.peek();
        }
      }
    }
    i4(r4);
  });
  l4("__r", function(i4, r4) {
    i4(r4);
    d4();
    var n3, t4 = r4.__c;
    if (t4) {
      t4.__$f &= -2;
      if (void 0 === (n3 = t4.__$u)) t4.__$u = n3 = function(i5) {
        var r5;
        j3(function() {
          r5 = this;
        });
        r5.c = function() {
          t4.__$f |= 1;
          t4.setState({});
        };
        return r5;
      }();
    }
    v4 = t4;
    d4(n3);
  });
  l4("__e", function(i4, r4, n3, t4) {
    d4();
    v4 = void 0;
    i4(r4, n3, t4);
  });
  l4("diffed", function(i4, r4) {
    d4();
    v4 = void 0;
    var n3;
    if ("string" == typeof r4.type && (n3 = r4.__e)) {
      var t4 = r4.__np, f4 = r4.props;
      if (t4) {
        var o4 = n3.U;
        if (o4) for (var e4 in o4) {
          var u3 = o4[e4];
          if (void 0 !== u3 && !(e4 in t4)) {
            u3.d();
            o4[e4] = void 0;
          }
        }
        else n3.U = o4 = {};
        for (var a4 in t4) {
          var c4 = o4[a4], s5 = t4[a4];
          if (void 0 === c4) {
            c4 = p4(n3, a4, s5, f4);
            o4[a4] = c4;
          } else c4.o(s5, f4);
        }
      }
    }
    i4(r4);
  });
  function p4(i4, r4, n3, t4) {
    var f4 = r4 in i4 && void 0 === i4.ownerSVGElement, o4 = y3(n3);
    return { o: function(i5, r5) {
      o4.value = i5;
      t4 = r5;
    }, d: j3(function() {
      var n4 = o4.value.value;
      if (t4[r4] !== n4) {
        t4[r4] = n4;
        if (f4) i4[r4] = n4;
        else if (n4) i4.setAttribute(r4, n4);
        else i4.removeAttribute(r4);
      }
    }) };
  }
  l4("unmount", function(i4, r4) {
    if ("string" == typeof r4.type) {
      var n3 = r4.__e;
      if (n3) {
        var t4 = n3.U;
        if (t4) {
          n3.U = void 0;
          for (var f4 in t4) {
            var o4 = t4[f4];
            if (o4) o4.d();
          }
        }
      }
    } else {
      var e4 = r4.__c;
      if (e4) {
        var u3 = e4.__$u;
        if (u3) {
          e4.__$u = void 0;
          u3.d();
        }
      }
    }
    i4(r4);
  });
  l4("__h", function(i4, r4, n3, t4) {
    if (t4 < 3 || 9 === t4) r4.__$f |= 2;
    i4(r4, n3, t4);
  });
  C.prototype.shouldComponentUpdate = function(i4, r4) {
    if (this.__R) return true;
    var n3 = this.__$u, t4 = n3 && void 0 !== n3.s;
    for (var f4 in r4) return true;
    if (this.__f || "boolean" == typeof this.u && true === this.u) {
      if (!(t4 || 2 & this.__$f || 4 & this.__$f)) return true;
      if (1 & this.__$f) return true;
    } else {
      if (!(t4 || 4 & this.__$f)) return true;
      if (3 & this.__$f) return true;
    }
    for (var o4 in i4) if ("__source" !== o4 && i4[o4] !== this.props[o4]) return true;
    for (var e4 in this.props) if (!(e4 in i4)) return true;
    return false;
  };
  function useSignal(i4) {
    return T2(function() {
      return y3(i4);
    }, []);
  }

  // webview-ui/src/utils/diff.ts
  function longestCommonSubsequence(a4, b3) {
    const m4 = a4.length;
    const n3 = b3.length;
    const dp = Array.from(
      { length: m4 + 1 },
      () => new Array(n3 + 1).fill(0)
    );
    for (let i5 = 1; i5 <= m4; i5++) {
      for (let j5 = 1; j5 <= n3; j5++) {
        dp[i5][j5] = a4[i5 - 1] === b3[j5 - 1] ? dp[i5 - 1][j5 - 1] + 1 : Math.max(dp[i5 - 1][j5], dp[i5][j5 - 1]);
      }
    }
    const pairs = [];
    let i4 = m4;
    let j4 = n3;
    while (i4 > 0 && j4 > 0) {
      if (a4[i4 - 1] === b3[j4 - 1]) {
        pairs.unshift([i4 - 1, j4 - 1]);
        i4--;
        j4--;
      } else if (dp[i4 - 1][j4] > dp[i4][j4 - 1]) {
        i4--;
      } else {
        j4--;
      }
    }
    return pairs;
  }
  function computeRawEdits(a4, b3) {
    const lcs = longestCommonSubsequence(a4, b3);
    const edits = [];
    let ia = 0;
    let ib = 0;
    for (const [ai, bi] of lcs) {
      while (ia < ai) edits.push({ type: "delete", line: a4[ia++] });
      while (ib < bi) edits.push({ type: "insert", line: b3[ib++] });
      edits.push({ type: "equal", line: a4[ia++] });
      ib++;
    }
    while (ia < a4.length) edits.push({ type: "delete", line: a4[ia++] });
    while (ib < b3.length) edits.push({ type: "insert", line: b3[ib++] });
    return edits;
  }
  function splitHunks(oldContent, newContent) {
    if (oldContent === newContent) return [];
    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");
    const rawEdits = computeRawEdits(oldLines, newLines);
    const hunks = [];
    let newIdx = 0;
    let editI = 0;
    while (editI < rawEdits.length) {
      const edit = rawEdits[editI];
      if (edit.type === "equal") {
        newIdx++;
        editI++;
        continue;
      }
      const newDocStartLine = newIdx;
      const removedLines = [];
      const addedLines = [];
      while (editI < rawEdits.length && rawEdits[editI].type !== "equal") {
        const e4 = rawEdits[editI];
        if (e4.type === "delete") {
          removedLines.push(e4.line);
        } else {
          addedLines.push(e4.line);
          newIdx++;
        }
        editI++;
      }
      hunks.push({
        index: hunks.length,
        removedLines,
        addedLines,
        newDocStartLine
      });
    }
    return hunks;
  }

  // webview-ui/src/components/DiffOverlayPanel.tsx
  var editsSignal = y3([]);
  var isVisibleSignal = g2(() => editsSignal.value.length > 0);
  window.addEventListener("champ:editSummary", (e4) => {
    const msg = e4.detail;
    if (Array.isArray(msg.edits)) {
      editsSignal.value = msg.edits;
    }
  });
  var hunkResolutions = y3(/* @__PURE__ */ new Map());
  function getVsCode() {
    if (typeof window.vscode !== "undefined") {
      return window.vscode;
    }
    return window.acquireVsCodeApi();
  }
  function HunkRow({
    edit,
    hunk
  }) {
    const key = `${edit.path}:${hunk.index}`;
    const resolution = hunkResolutions.value.get(key);
    function handleAccept() {
      getVsCode().postMessage({
        type: "acceptHunkAtLine",
        filePath: edit.path,
        line: hunk.newDocStartLine
      });
      const next = new Map(hunkResolutions.value);
      next.set(key, "accepted");
      hunkResolutions.value = next;
    }
    function handleReject() {
      getVsCode().postMessage({
        type: "rejectHunkAtLine",
        filePath: edit.path,
        line: hunk.newDocStartLine
      });
      const next = new Map(hunkResolutions.value);
      next.set(key, "rejected");
      hunkResolutions.value = next;
    }
    return /* @__PURE__ */ React.createElement(
      "div",
      {
        class: `hunk-row${resolution ? ` hunk-${resolution}` : ""}`,
        style: "margin: 4px 0; padding: 4px 8px; background: var(--vscode-editor-background); border-left: 3px solid var(--vscode-focusBorder);"
      },
      /* @__PURE__ */ React.createElement("div", { style: "display:flex; gap:6px; margin-bottom:4px; align-items:center;" }, /* @__PURE__ */ React.createElement("span", { style: "font-size:11px; color:var(--vscode-descriptionForeground);" }, "Hunk ", hunk.index + 1), !resolution && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(
        "button",
        {
          onClick: handleAccept,
          style: "font-size:11px; padding:1px 6px; cursor:pointer;"
        },
        "Accept"
      ), /* @__PURE__ */ React.createElement(
        "button",
        {
          onClick: handleReject,
          style: "font-size:11px; padding:1px 6px; cursor:pointer;"
        },
        "Reject"
      )), resolution === "accepted" && /* @__PURE__ */ React.createElement("span", { style: "font-size:11px; color:var(--vscode-terminal-ansiGreen);" }, "Accepted"), resolution === "rejected" && /* @__PURE__ */ React.createElement("span", { style: "font-size:11px; color:var(--vscode-editorError-foreground);" }, "Rejected")),
      /* @__PURE__ */ React.createElement("pre", { style: "margin:0; font-size:11px; overflow-x:auto;" }, hunk.removedLines.map((l5, i4) => /* @__PURE__ */ React.createElement(
        "div",
        {
          key: `del-${i4}`,
          style: "color:var(--vscode-gitDecoration-deletedResourceForeground);"
        },
        "- ",
        l5
      )), hunk.addedLines.map((l5, i4) => /* @__PURE__ */ React.createElement(
        "div",
        {
          key: `add-${i4}`,
          style: "color:var(--vscode-gitDecoration-addedResourceForeground);"
        },
        "+ ",
        l5
      )))
    );
  }
  function FileSection({ edit }) {
    const hunks = splitHunks(edit.oldContent, edit.newContent);
    function handleRevertFile() {
      getVsCode().postMessage({
        type: "revertEdit",
        path: edit.path,
        restoreContent: edit.oldContent
      });
    }
    return /* @__PURE__ */ React.createElement("div", { style: "margin-bottom:12px;" }, /* @__PURE__ */ React.createElement(
      "div",
      {
        style: "display:flex; justify-content:space-between; align-items:center;\n               padding:4px 8px; background:var(--vscode-sideBarSectionHeader-background);"
      },
      /* @__PURE__ */ React.createElement("span", { style: "font-size:12px; font-weight:600; font-family:monospace;" }, edit.path),
      /* @__PURE__ */ React.createElement(
        "button",
        {
          onClick: handleRevertFile,
          style: "font-size:11px; padding:1px 6px; cursor:pointer;"
        },
        "Revert File"
      )
    ), hunks.map((hunk) => /* @__PURE__ */ React.createElement(HunkRow, { key: `${edit.path}:${hunk.index}`, edit, hunk })));
  }
  function DiffOverlayPanel() {
    if (!isVisibleSignal.value) return null;
    const edits = editsSignal.value;
    function handleAcceptAll() {
      getVsCode().postMessage({ type: "acceptAllEdits" });
      editsSignal.value = [];
      hunkResolutions.value = /* @__PURE__ */ new Map();
    }
    function handleRejectAll() {
      const allEdits = edits.map((e4) => ({
        path: e4.path,
        restoreContent: e4.oldContent
      }));
      getVsCode().postMessage({ type: "revertAllEdits", edits: allEdits });
      editsSignal.value = [];
      hunkResolutions.value = /* @__PURE__ */ new Map();
    }
    return /* @__PURE__ */ React.createElement(
      "div",
      {
        style: "position:fixed; bottom:0; left:0; right:0; max-height:50vh; overflow-y:auto;\n             background:var(--vscode-sideBar-background);\n             border-top:1px solid var(--vscode-panel-border);\n             z-index:50; box-shadow:0 -4px 12px rgba(0,0,0,0.3);"
      },
      /* @__PURE__ */ React.createElement(
        "div",
        {
          style: "display:flex; justify-content:space-between; align-items:center;\n               padding:6px 12px; background:var(--vscode-titleBar-activeBackground);"
        },
        /* @__PURE__ */ React.createElement("span", { style: "font-weight:600; font-size:13px;" }, "Champ Edits (", edits.length, " file", edits.length !== 1 ? "s" : "", ")"),
        /* @__PURE__ */ React.createElement("div", { style: "display:flex; gap:8px;" }, /* @__PURE__ */ React.createElement(
          "button",
          {
            onClick: handleAcceptAll,
            style: "padding:3px 10px; cursor:pointer; background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; border-radius:2px;"
          },
          "Accept All"
        ), /* @__PURE__ */ React.createElement(
          "button",
          {
            onClick: handleRejectAll,
            style: "padding:3px 10px; cursor:pointer;"
          },
          "Reject All"
        ))
      ),
      /* @__PURE__ */ React.createElement("div", { style: "padding:8px 12px;" }, edits.map((edit) => /* @__PURE__ */ React.createElement(FileSection, { key: edit.path, edit })))
    );
  }

  // webview-ui/src/components/AgentGraphPanel.tsx
  var teamStateSignal = y3(null);
  var isVisibleSignal2 = g2(() => teamStateSignal.value !== null);
  window.addEventListener("champ:teamUpdate", (e4) => {
    const msg = e4.detail;
    if (msg.state) {
      teamStateSignal.value = msg.state;
    }
  });
  function getVsCode2() {
    if (typeof window.vscode !== "undefined") {
      return window.vscode;
    }
    return window.acquireVsCodeApi();
  }
  var NODE_WIDTH = 160;
  var NODE_HEIGHT = 48;
  var H_GAP = 40;
  var V_GAP = 60;
  var PADDING = 20;
  function statusToFill(status) {
    switch (status) {
      case "pending":
        return "var(--vscode-badge-background)";
      case "running":
        return "var(--vscode-progressBar-background)";
      case "done":
        return "var(--vscode-terminal-ansiGreen)";
      case "failed":
        return "var(--vscode-inputValidation-errorBackground)";
      case "skipped":
        return "var(--vscode-disabledForeground)";
      case "blocked":
        return "var(--vscode-inputValidation-warningBackground)";
      default:
        return "var(--vscode-badge-background)";
    }
  }
  function statusToStroke(status) {
    switch (status) {
      case "pending":
        return "var(--vscode-badge-foreground)";
      case "running":
        return "var(--vscode-focusBorder)";
      case "done":
        return "var(--vscode-terminal-ansiGreen)";
      case "failed":
        return "var(--vscode-inputValidation-errorBorder)";
      case "skipped":
        return "var(--vscode-descriptionForeground)";
      case "blocked":
        return "var(--vscode-inputValidation-warningBorder)";
      default:
        return "var(--vscode-badge-foreground)";
    }
  }
  function computeLayout(agents, dependsOnMap) {
    const inDegree = /* @__PURE__ */ new Map();
    const adj = /* @__PURE__ */ new Map();
    const idSet = new Set(agents.map((a4) => a4.id));
    for (const a4 of agents) {
      inDegree.set(a4.id, 0);
      adj.set(a4.id, []);
    }
    for (const a4 of agents) {
      for (const dep of dependsOnMap.get(a4.id) ?? []) {
        if (idSet.has(dep)) {
          adj.get(dep).push(a4.id);
          inDegree.set(a4.id, (inDegree.get(a4.id) ?? 0) + 1);
        }
      }
    }
    const layers = [];
    let frontier = [...inDegree.entries()].filter(([, d5]) => d5 === 0).map(([id]) => id);
    while (frontier.length > 0) {
      layers.push(frontier);
      const next = [];
      for (const id of frontier) {
        for (const neighborId of adj.get(id) ?? []) {
          const newDeg = (inDegree.get(neighborId) ?? 0) - 1;
          inDegree.set(neighborId, newDeg);
          if (newDeg === 0) next.push(neighborId);
        }
      }
      frontier = next;
    }
    const positions = /* @__PURE__ */ new Map();
    layers.forEach((layer, layerIdx) => {
      const y4 = PADDING + layerIdx * (NODE_HEIGHT + V_GAP) + NODE_HEIGHT / 2;
      layer.forEach((id, colIdx) => {
        const x3 = PADDING + colIdx * (NODE_WIDTH + H_GAP) + NODE_WIDTH / 2;
        positions.set(id, { x: x3, y: y4 });
      });
    });
    return positions;
  }
  function AgentNode({
    agent,
    x: x3,
    y: y4
  }) {
    const fill = statusToFill(agent.status);
    const stroke = statusToStroke(agent.status);
    function handleClick() {
      getVsCode2().postMessage({ type: "focusTeamAgent", agentId: agent.id });
    }
    return /* @__PURE__ */ React.createElement(
      "g",
      {
        transform: `translate(${x3 - NODE_WIDTH / 2}, ${y4 - NODE_HEIGHT / 2})`,
        onClick: handleClick,
        style: "cursor:pointer;"
      },
      /* @__PURE__ */ React.createElement(
        "rect",
        {
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          rx: 6,
          ry: 6,
          fill,
          stroke,
          strokeWidth: 2
        }
      ),
      /* @__PURE__ */ React.createElement(
        "text",
        {
          x: NODE_WIDTH / 2,
          y: NODE_HEIGHT * 0.42,
          textAnchor: "middle",
          dominantBaseline: "middle",
          fill: "var(--vscode-editor-foreground)",
          fontSize: 12,
          fontWeight: "600"
        },
        agent.name.length > 18 ? agent.name.slice(0, 16) + "\u2026" : agent.name
      ),
      /* @__PURE__ */ React.createElement(
        "text",
        {
          x: NODE_WIDTH / 2,
          y: NODE_HEIGHT * 0.72,
          textAnchor: "middle",
          dominantBaseline: "middle",
          fill: "var(--vscode-descriptionForeground)",
          fontSize: 10
        },
        agent.status,
        agent.status === "running" ? " \u25CF" : ""
      )
    );
  }
  function EdgeLine({
    fromPos,
    toPos
  }) {
    const x1 = fromPos.x;
    const y1 = fromPos.y + NODE_HEIGHT / 2;
    const x22 = toPos.x;
    const y22 = toPos.y - NODE_HEIGHT / 2;
    const midY = (y1 + y22) / 2;
    return /* @__PURE__ */ React.createElement(
      "path",
      {
        d: `M ${x1} ${y1} C ${x1} ${midY}, ${x22} ${midY}, ${x22} ${y22}`,
        fill: "none",
        stroke: "var(--vscode-descriptionForeground)",
        strokeWidth: 1.5,
        opacity: 0.6
      }
    );
  }
  function AgentGraphPanel() {
    if (!isVisibleSignal2.value) return null;
    const state = teamStateSignal.value;
    const dependsOnMap = /* @__PURE__ */ new Map();
    for (const agent of state.agents) {
      dependsOnMap.set(agent.id, []);
    }
    const positions = computeLayout(state.agents, dependsOnMap);
    let maxX = 0;
    let maxY = 0;
    for (const { x: x3, y: y4 } of positions.values()) {
      if (x3 + NODE_WIDTH / 2 + PADDING > maxX)
        maxX = x3 + NODE_WIDTH / 2 + PADDING;
      if (y4 + NODE_HEIGHT / 2 + PADDING > maxY)
        maxY = y4 + NODE_HEIGHT / 2 + PADDING;
    }
    const svgWidth = Math.max(maxX, 200);
    const svgHeight = Math.max(maxY, 120);
    function handleClose() {
      teamStateSignal.value = null;
    }
    return /* @__PURE__ */ React.createElement(
      "div",
      {
        style: "position:fixed; top:48px; right:12px; width:340px;\n             background:var(--vscode-sideBar-background);\n             border:1px solid var(--vscode-panel-border);\n             border-radius:6px; z-index:60; box-shadow:0 4px 16px rgba(0,0,0,0.3);\n             overflow:hidden;"
      },
      /* @__PURE__ */ React.createElement(
        "div",
        {
          style: "display:flex; justify-content:space-between; align-items:center;\n               padding:6px 10px; background:var(--vscode-titleBar-activeBackground);"
        },
        /* @__PURE__ */ React.createElement("span", { style: "font-size:12px; font-weight:600;" }, state.teamName, " \u2014 ", state.status),
        /* @__PURE__ */ React.createElement(
          "button",
          {
            onClick: handleClose,
            style: "background:none; border:none; cursor:pointer; color:var(--vscode-icon-foreground); font-size:14px;",
            "aria-label": "Close agent graph"
          },
          "x"
        )
      ),
      /* @__PURE__ */ React.createElement("div", { style: "overflow:auto; max-height:300px;" }, /* @__PURE__ */ React.createElement(
        "svg",
        {
          width: svgWidth,
          height: svgHeight,
          xmlns: "http://www.w3.org/2000/svg"
        },
        state.agents.map(
          (agent) => (dependsOnMap.get(agent.id) ?? []).map((depId) => {
            const fromPos = positions.get(depId);
            const toPos = positions.get(agent.id);
            if (!fromPos || !toPos) return null;
            return /* @__PURE__ */ React.createElement(
              EdgeLine,
              {
                key: `${depId}->${agent.id}`,
                fromPos,
                toPos
              }
            );
          })
        ),
        state.agents.map((agent) => {
          const pos = positions.get(agent.id);
          if (!pos) return null;
          return /* @__PURE__ */ React.createElement(AgentNode, { key: agent.id, agent, x: pos.x, y: pos.y });
        })
      )),
      /* @__PURE__ */ React.createElement(
        "div",
        {
          style: "padding:4px 10px; font-size:10px; color:var(--vscode-descriptionForeground);\n               border-top:1px solid var(--vscode-panel-border);"
        },
        state.totalTokens.toLocaleString(),
        " tokens",
        state.tokenBudget ? ` / ${state.tokenBudget.toLocaleString()} budget` : ""
      )
    );
  }

  // webview-ui/src/components/McpMarketplacePanel.tsx
  var isOpenSignal = y3(false);
  var entriesSignal = y3([]);
  var isLoadingSignal = y3(false);
  var searchQuerySignal = y3("");
  var installedNamesSignal = y3(/* @__PURE__ */ new Set());
  var installErrorsSignal = y3(/* @__PURE__ */ new Map());
  var filteredEntriesSignal = g2(() => {
    const q2 = searchQuerySignal.value.toLowerCase();
    if (!q2) return entriesSignal.value;
    return entriesSignal.value.filter(
      (e4) => e4.name.toLowerCase().includes(q2) || e4.description.toLowerCase().includes(q2) || e4.tags.some((t4) => t4.toLowerCase().includes(q2))
    );
  });
  function getVsCode3() {
    if (typeof window.vscode !== "undefined") {
      return window.vscode;
    }
    return window.acquireVsCodeApi();
  }
  window.addEventListener("champ:mcpMarketplaceOpen", () => {
    isOpenSignal.value = true;
    isLoadingSignal.value = true;
    entriesSignal.value = [];
    installedNamesSignal.value = /* @__PURE__ */ new Set();
    installErrorsSignal.value = /* @__PURE__ */ new Map();
    searchQuerySignal.value = "";
    getVsCode3().postMessage({ type: "fetchMcpMarketplace" });
  });
  window.addEventListener("champ:mcpMarketplaceEntries", (e4) => {
    const msg = e4.detail;
    if (Array.isArray(msg.entries)) {
      entriesSignal.value = msg.entries;
    }
    isLoadingSignal.value = false;
  });
  window.addEventListener("champ:mcpMarketplaceInstallComplete", (e4) => {
    const msg = e4.detail;
    if (msg.success) {
      const next = new Set(installedNamesSignal.value);
      next.add(msg.name);
      installedNamesSignal.value = next;
    } else {
      const next = new Map(installErrorsSignal.value);
      next.set(msg.name, msg.errorMessage ?? "Installation failed");
      installErrorsSignal.value = next;
    }
  });
  function TagChip({ tag }) {
    return /* @__PURE__ */ React.createElement(
      "span",
      {
        style: "display:inline-block; padding:1px 6px; margin:1px 2px; border-radius:10px;\n             font-size:10px; background:var(--vscode-badge-background); color:var(--vscode-badge-foreground);"
      },
      tag
    );
  }
  function ServerCard({ entry }) {
    const isInstalled = installedNamesSignal.value.has(entry.name);
    const errorMsg = installErrorsSignal.value.get(entry.name);
    function handleInstall() {
      getVsCode3().postMessage({ type: "mcpMarketplaceInstall", entry });
    }
    return /* @__PURE__ */ React.createElement(
      "div",
      {
        style: "border:1px solid var(--vscode-panel-border); border-radius:6px;\n             padding:10px 12px; background:var(--vscode-editor-background);\n             display:flex; flex-direction:column; gap:6px;"
      },
      /* @__PURE__ */ React.createElement("div", { style: "display:flex; justify-content:space-between; align-items:center;" }, /* @__PURE__ */ React.createElement("span", { style: "font-size:13px; font-weight:600;" }, entry.name), /* @__PURE__ */ React.createElement(
        "span",
        {
          style: "font-size:10px; padding:1px 5px; border-radius:3px;\n                 background:var(--vscode-badge-background); color:var(--vscode-badge-foreground);"
        },
        entry.transport
      )),
      /* @__PURE__ */ React.createElement("p", { style: "margin:0; font-size:12px; color:var(--vscode-descriptionForeground); line-height:1.4;" }, entry.description),
      /* @__PURE__ */ React.createElement("div", { style: "display:flex; flex-wrap:wrap; gap:2px;" }, entry.tags.map((tag) => /* @__PURE__ */ React.createElement(TagChip, { key: tag, tag }))),
      errorMsg && /* @__PURE__ */ React.createElement("p", { style: "margin:0; font-size:11px; color:var(--vscode-inputValidation-errorForeground);" }, "Error: ", errorMsg),
      /* @__PURE__ */ React.createElement(
        "button",
        {
          onClick: isInstalled ? void 0 : handleInstall,
          disabled: isInstalled,
          style: `margin-top:4px; padding:4px 10px; cursor:${isInstalled ? "default" : "pointer"};
                background:${isInstalled ? "transparent" : "var(--vscode-button-background)"};
                color:${isInstalled ? "var(--vscode-terminal-ansiGreen)" : "var(--vscode-button-foreground)"};
                border:${isInstalled ? "1px solid var(--vscode-terminal-ansiGreen)" : "none"};
                border-radius:3px; font-size:12px;`
        },
        isInstalled ? "Installed" : "Install"
      )
    );
  }
  function McpMarketplacePanel() {
    if (!isOpenSignal.value) return null;
    function handleClose() {
      isOpenSignal.value = false;
    }
    function handleSearchInput(e4) {
      searchQuerySignal.value = e4.target.value;
    }
    const filtered = filteredEntriesSignal.value;
    return /* @__PURE__ */ React.createElement(
      "div",
      {
        style: "position:fixed; inset:0; z-index:200;\n             background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center;",
        onClick: (e4) => {
          if (e4.target === e4.currentTarget) handleClose();
        }
      },
      /* @__PURE__ */ React.createElement(
        "div",
        {
          style: "background:var(--vscode-sideBar-background); border-radius:8px;\n               width:min(640px,90vw); max-height:80vh; display:flex; flex-direction:column;\n               overflow:hidden; box-shadow:0 8px 32px rgba(0,0,0,0.5);"
        },
        /* @__PURE__ */ React.createElement(
          "div",
          {
            style: "display:flex; justify-content:space-between; align-items:center;\n                 padding:12px 16px; background:var(--vscode-titleBar-activeBackground);\n                 flex-shrink:0;"
          },
          /* @__PURE__ */ React.createElement("span", { style: "font-size:14px; font-weight:700;" }, "MCP Server Marketplace"),
          /* @__PURE__ */ React.createElement(
            "button",
            {
              onClick: handleClose,
              style: "background:none; border:none; cursor:pointer;\n                   color:var(--vscode-icon-foreground); font-size:18px; line-height:1;",
              "aria-label": "Close marketplace"
            },
            "x"
          )
        ),
        /* @__PURE__ */ React.createElement("div", { style: "padding:10px 16px; flex-shrink:0;" }, /* @__PURE__ */ React.createElement(
          "input",
          {
            type: "text",
            placeholder: "Search servers...",
            value: searchQuerySignal.value,
            onInput: handleSearchInput,
            style: "width:100%; box-sizing:border-box; padding:6px 10px;\n                   background:var(--vscode-input-background); color:var(--vscode-input-foreground);\n                   border:1px solid var(--vscode-input-border); border-radius:4px; font-size:13px;"
          }
        )),
        /* @__PURE__ */ React.createElement("div", { style: "overflow-y:auto; padding:0 16px 16px; flex:1;" }, isLoadingSignal.value && /* @__PURE__ */ React.createElement("p", { style: "text-align:center; color:var(--vscode-descriptionForeground); padding:24px 0;" }, "Loading marketplace..."), !isLoadingSignal.value && filtered.length === 0 && /* @__PURE__ */ React.createElement("p", { style: "text-align:center; color:var(--vscode-descriptionForeground); padding:24px 0;" }, searchQuerySignal.value ? "No servers match your search." : "No servers available."), !isLoadingSignal.value && filtered.length > 0 && /* @__PURE__ */ React.createElement("div", { style: "display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:10px;" }, filtered.map((entry) => /* @__PURE__ */ React.createElement(ServerCard, { key: entry.name, entry }))))
      )
    );
  }

  // webview-ui/src/components/MemoryPanel.tsx
  var vscode = window.acquireVsCodeApi?.();
  function formatTime(ts) {
    return new Date(ts).toLocaleDateString(void 0, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }
  function MemoryRow({
    item,
    onDelete,
    onTogglePin
  }) {
    return /* @__PURE__ */ React.createElement(
      "div",
      {
        style: {
          borderBottom: "1px solid var(--vscode-panel-border)",
          padding: "10px 0",
          display: "flex",
          flexDirection: "column",
          gap: "4px"
        }
      },
      /* @__PURE__ */ React.createElement(
        "div",
        {
          style: {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start"
          }
        },
        /* @__PURE__ */ React.createElement(
          "span",
          {
            style: {
              fontSize: "13px",
              color: "var(--vscode-foreground)",
              flex: 1,
              marginRight: "8px"
            }
          },
          item.assistantSummary
        ),
        /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: "6px", flexShrink: 0 } }, /* @__PURE__ */ React.createElement(
          "button",
          {
            title: item.pinned ? "Unpin" : "Pin (always inject)",
            onClick: () => onTogglePin(item.id, !item.pinned),
            style: {
              background: "none",
              border: "1px solid var(--vscode-button-border, #555)",
              borderRadius: "3px",
              color: item.pinned ? "var(--vscode-charts-yellow)" : "var(--vscode-descriptionForeground)",
              cursor: "pointer",
              padding: "2px 6px",
              fontSize: "12px"
            }
          },
          item.pinned ? "\u{1F4CC} Pinned" : "\u{1F4CC} Pin"
        ), /* @__PURE__ */ React.createElement(
          "button",
          {
            title: "Delete memory",
            onClick: () => onDelete(item.id),
            style: {
              background: "none",
              border: "1px solid var(--vscode-button-border, #555)",
              borderRadius: "3px",
              color: "var(--vscode-errorForeground)",
              cursor: "pointer",
              padding: "2px 6px",
              fontSize: "12px"
            }
          },
          "\u2715"
        ))
      ),
      /* @__PURE__ */ React.createElement(
        "span",
        {
          style: {
            fontSize: "11px",
            color: "var(--vscode-descriptionForeground)"
          }
        },
        item.userQuery !== "manual" ? `From: "${item.userQuery}"` : "Manual entry",
        " ",
        "\xB7 ",
        formatTime(item.timestamp)
      )
    );
  }
  function AddMemoryForm({
    onAdd
  }) {
    const [text, setText] = d2("");
    return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: "8px", marginBottom: "16px" } }, /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "text",
        placeholder: "Remember... (e.g. 'We use Postgres not MySQL')",
        value: text,
        onInput: (e4) => setText(e4.target.value),
        onKeyDown: (e4) => {
          if (e4.key === "Enter" && text.trim()) {
            onAdd(text.trim());
            setText("");
          }
        },
        style: {
          flex: 1,
          background: "var(--vscode-input-background)",
          border: "1px solid var(--vscode-input-border, #555)",
          color: "var(--vscode-input-foreground)",
          borderRadius: "3px",
          padding: "6px 8px",
          fontSize: "13px"
        }
      }
    ), /* @__PURE__ */ React.createElement(
      "button",
      {
        onClick: () => {
          if (text.trim()) {
            onAdd(text.trim());
            setText("");
          }
        },
        disabled: !text.trim(),
        style: {
          background: "var(--vscode-button-background)",
          color: "var(--vscode-button-foreground)",
          border: "none",
          borderRadius: "3px",
          padding: "6px 12px",
          cursor: text.trim() ? "pointer" : "not-allowed",
          fontSize: "13px"
        }
      },
      "Add"
    ));
  }
  function MemoryPanel() {
    const [items, setItems] = d2([]);
    y2(() => {
      const handler = (event) => {
        const msg = event.data;
        if (msg.type === "memoryList" && Array.isArray(msg.items)) {
          setItems(msg.items);
        }
      };
      window.addEventListener("message", handler);
      return () => window.removeEventListener("message", handler);
    }, []);
    const handleDelete = (id) => {
      vscode?.postMessage({ type: "memoryDelete", id });
      setItems((prev) => prev.filter((m4) => m4.id !== id));
    };
    const handleTogglePin = (id, pinned) => {
      vscode?.postMessage({ type: "memoryPin", id, pinned });
      setItems((prev) => prev.map((m4) => m4.id === id ? { ...m4, pinned } : m4));
    };
    const handleAdd = (text) => {
      vscode?.postMessage({ type: "memoryAdd", text });
    };
    const pinnedItems = items.filter((m4) => m4.pinned);
    const unpinnedItems = items.filter((m4) => !m4.pinned);
    return /* @__PURE__ */ React.createElement("div", { style: { maxWidth: "700px", margin: "0 auto", padding: "8px" } }, /* @__PURE__ */ React.createElement(
      "h2",
      {
        style: {
          fontSize: "16px",
          marginBottom: "16px",
          color: "var(--vscode-foreground)"
        }
      },
      "Memory Bank",
      /* @__PURE__ */ React.createElement(
        "span",
        {
          style: {
            fontSize: "12px",
            color: "var(--vscode-descriptionForeground)",
            marginLeft: "8px",
            fontWeight: "normal"
          }
        },
        items.length,
        " stored \xB7 ",
        pinnedItems.length,
        " pinned"
      )
    ), /* @__PURE__ */ React.createElement(AddMemoryForm, { onAdd: handleAdd }), pinnedItems.length > 0 && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(
      "h3",
      {
        style: {
          fontSize: "13px",
          color: "var(--vscode-charts-yellow)",
          marginBottom: "8px"
        }
      },
      "\u{1F4CC} Always injected"
    ), pinnedItems.map((item) => /* @__PURE__ */ React.createElement(
      MemoryRow,
      {
        key: item.id,
        item,
        onDelete: handleDelete,
        onTogglePin: handleTogglePin
      }
    )), unpinnedItems.length > 0 && /* @__PURE__ */ React.createElement(
      "h3",
      {
        style: {
          fontSize: "13px",
          color: "var(--vscode-descriptionForeground)",
          margin: "16px 0 8px"
        }
      },
      "Recent memories"
    )), unpinnedItems.length === 0 && pinnedItems.length === 0 && /* @__PURE__ */ React.createElement(
      "p",
      {
        style: {
          color: "var(--vscode-descriptionForeground)",
          fontSize: "13px"
        }
      },
      "No memories yet. Champ stores conversation summaries here automatically, or add one manually above."
    ), unpinnedItems.map((item) => /* @__PURE__ */ React.createElement(
      MemoryRow,
      {
        key: item.id,
        item,
        onDelete: handleDelete,
        onTogglePin: handleTogglePin
      }
    )));
  }

  // webview-ui/src/index.tsx
  function App() {
    const isMemoryPanel = window.__CHAMP_MEMORY_PANEL__;
    if (isMemoryPanel) {
      return /* @__PURE__ */ React.createElement(MemoryPanel, null);
    }
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(DiffOverlayPanel, null), /* @__PURE__ */ React.createElement(AgentGraphPanel, null), /* @__PURE__ */ React.createElement(McpMarketplacePanel, null));
  }
  var root = document.getElementById("champ-panels");
  if (root) {
    R(/* @__PURE__ */ React.createElement(App, null), root);
  }
})();
//# sourceMappingURL=components.js.map
