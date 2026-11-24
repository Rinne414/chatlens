"use strict";

/* ---------- a picture looked at closer, and moved about ----------
   Shared by the gallery's 大图 and the picture in its window: the wheel makes
   the picture bigger or smaller around the mouse, a click goes between whole
   and close-up, and a close-up is dragged about.

   pictureZoomer({ image, frame, onCloser, onChange }):
     image()      the <img> on screen now (or null); it may be drawn anew at
                  any time, the zoom is put back on it with apply(node)
     frame(node)  the box the picture must stay near
     onCloser()   told every time the picture is made bigger
     onChange(node, scale)  told after the zoom was put on a node */

const PICTURE_ZOOM_MAX = 8;
const PICTURE_ZOOM_WHEEL = 0.0016;
// Some mice report lines instead of pixels.
const PICTURE_WHEEL_LINE = 33;
// A close-up may be pushed this far past the edge of its frame, no further.
const PICTURE_ZOOM_SLACK = 60;
// Moving less than this between press and release is a click, not a drag.
const PICTURE_DRAG_START = 4;

const pictureZoomer = ({ image, frame, onCloser = () => {}, onChange = () => {} }) => {
  const state = { scale: 1, x: 0, y: 0, drag: null, dragged: false };

  const apply = (node = image()) => {
    if (node === null) {
      return;
    }
    node.style.transform = state.scale === 1 ? "" : `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    node.classList.toggle("zoomed", state.scale > 1);
    node.classList.toggle("dragging", state.drag !== null);
    onChange(node, state.scale);
  };

  const reset = () => {
    Object.assign(state, { scale: 1, x: 0, y: 0, drag: null, dragged: false });
    apply();
  };

  // The interface can be shown larger or smaller (界面大小): the mouse reports
  // screen pixels, the picture is moved in the page's own.
  const screenRatio = (node) => {
    const shown = node.getBoundingClientRect().width;
    const own = node.offsetWidth * state.scale;
    return shown > 0 && own > 0 ? shown / own : 1;
  };

  // How far the picture may be moved at this size: its edge stays near the frame's.
  const clamp = (node, scale, x, y) => {
    const box = frame(node);
    const limit = (size, room) => Math.max(0, (size * scale - room) / 2 + PICTURE_ZOOM_SLACK);
    const maxX = limit(node.offsetWidth, box?.offsetWidth ?? window.innerWidth);
    const maxY = limit(node.offsetHeight, box?.offsetHeight ?? window.innerHeight);
    return { x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) };
  };

  // The point under the mouse stays under the mouse while the size changes.
  const zoomAt = (clientX, clientY, wanted) => {
    const node = image();
    if (node === null) {
      return;
    }
    const scale = Math.min(PICTURE_ZOOM_MAX, Math.max(1, wanted));
    if (scale === 1) {
      reset();
      return;
    }
    const closer = scale > state.scale;
    const box = node.getBoundingClientRect();
    const screen = screenRatio(node);
    // The mouse, measured from where the picture's middle sits when it has not been moved.
    const pointX = (clientX - box.left - box.width / 2) / screen + state.x;
    const pointY = (clientY - box.top - box.height / 2) / screen + state.y;
    const ratio = scale / state.scale;
    Object.assign(state, { scale, ...clamp(node, scale, pointX - (pointX - state.x) * ratio, pointY - (pointY - state.y) * ratio) });
    apply(node);
    if (closer) {
      onCloser();
    }
  };

  // A click on the picture: close up at that point (its real pixels when it is
  // shown smaller than it is, else twice the size), or whole again.
  const toggleAt = (event) => {
    if (state.scale > 1) {
      reset();
      return;
    }
    const node = image();
    const shown = node?.getBoundingClientRect().width ?? 0;
    const real = shown > 0 ? node.naturalWidth / shown : 1;
    zoomAt(event.clientX, event.clientY, real > 1.15 ? real : 2);
  };

  const wheel = (event) => {
    event.preventDefault();
    if (event.deltaY === 0) {
      return;
    }
    const pixels = event.deltaMode === 1 ? event.deltaY * PICTURE_WHEEL_LINE : event.deltaY;
    zoomAt(event.clientX, event.clientY, state.scale * Math.exp(-pixels * PICTURE_ZOOM_WHEEL));
  };

  // true when the press starts moving a close-up about.
  const dragStart = (event) => {
    if (event.button !== 0) {
      return false;
    }
    state.dragged = false;
    if (state.scale === 1) {
      return false;
    }
    event.preventDefault();
    state.drag = { pointerId: event.pointerId, fromX: event.clientX, fromY: event.clientY, x: state.x, y: state.y, screen: screenRatio(event.currentTarget) };
    try {
      // So the drag goes on when the mouse leaves the picture.
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // A pointer the browser no longer tracks: the drag still works while it stays on the picture.
    }
    apply(event.currentTarget);
    return true;
  };

  const dragMove = (event) => {
    const drag = state.drag;
    if (drag === null || drag.pointerId !== event.pointerId) {
      return;
    }
    const byX = event.clientX - drag.fromX;
    const byY = event.clientY - drag.fromY;
    if (!state.dragged && Math.hypot(byX, byY) < PICTURE_DRAG_START) {
      return;
    }
    state.dragged = true;
    Object.assign(state, clamp(event.currentTarget, state.scale, drag.x + byX / drag.screen, drag.y + byY / drag.screen));
    apply(event.currentTarget);
  };

  const dragEnd = (event) => {
    if (state.drag?.pointerId !== event.pointerId) {
      return;
    }
    state.drag = null;
    apply(event.currentTarget);
  };

  // For the click that follows a release: true once after a drag, so the
  // release that ends a drag is not taken for a click on the picture.
  const wasDragged = () => {
    const dragged = state.dragged;
    state.dragged = false;
    return dragged;
  };

  return { state, apply, reset, zoomAt, toggleAt, wheel, dragStart, dragMove, dragEnd, wasDragged };
};
