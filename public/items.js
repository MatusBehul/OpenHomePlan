// Furniture, fittings and appliances. floor.items[] = { id, type, name?, x, y, w, d, h, rot, color?, circuit? }
// `mount` lifts an item off the floor: a height in metres, or 'ceiling'.
// x/y is the top-left of the footprint in plan; w is the width along the item's front, d its
// depth; rot (0/90/180/270, clockwise) turns it: 0 = back to the north, facing south.
// `needs` drives the utilities generator (sockets, circuits, water, drains, gas).
import { inRoom } from './geometry.js';

export const ITEM_CATEGORIES = {
  kitchen: 'Kitchen',
  living: 'Living & dining',
  bedroom: 'Bedroom & storage',
  bathroom: 'Bathroom',
  utility: 'Utility & technical',
  garage: 'Garage & outdoor',
};

// power in W; voltage 230 (single phase) or 400 (three phase); dedicated = own circuit
export const ITEMS = {
  // kitchen
  'kitchen-base': { label: 'Kitchen counter', cat: 'kitchen', w: 2.4, d: 0.6, h: 0.9, color: '#e9e4da' },
  'kitchen-tall': { label: 'Tall kitchen cabinet', cat: 'kitchen', w: 0.6, d: 0.6, h: 2.2, color: '#e9e4da' },
  'kitchen-wall': { label: 'Kitchen wall cabinet', cat: 'kitchen', w: 0.8, d: 0.35, h: 0.7, color: '#e9e4da', mount: 1.5 },
  'kitchen-island': { label: 'Kitchen island', cat: 'kitchen', w: 1.8, d: 0.9, h: 0.9, color: '#d8d2c6' },
  'sink-kitchen': { label: 'Kitchen sink', cat: 'kitchen', w: 0.8, d: 0.6, h: 0.9, color: '#cfd6dc', needs: { water: ['cold', 'hot'], drain: 50 } },
  hob: { label: 'Induction hob', cat: 'kitchen', w: 0.6, d: 0.6, h: 0.9, color: '#3b3d40', needs: { power: 7400, voltage: 400, dedicated: true } },
  oven: { label: 'Oven', cat: 'kitchen', w: 0.6, d: 0.6, h: 0.9, color: '#55585c', needs: { power: 3500, voltage: 230, dedicated: true } },
  fridge: { label: 'Fridge-freezer', cat: 'kitchen', w: 0.6, d: 0.65, h: 1.9, color: '#f4f4f4', needs: { power: 200, voltage: 230 } },
  dishwasher: { label: 'Dishwasher', cat: 'kitchen', w: 0.6, d: 0.6, h: 0.85, color: '#dadde0', needs: { power: 2200, voltage: 230, dedicated: true, water: ['cold'], drain: 40 } },
  // living & dining
  'sofa-3': { label: 'Sofa (3 seats)', cat: 'living', w: 2.2, d: 0.95, h: 0.85, color: '#8c9aa8' },
  'sofa-corner': { label: 'Corner sofa', cat: 'living', w: 2.8, d: 1.8, h: 0.85, color: '#8c9aa8' },
  armchair: { label: 'Armchair', cat: 'living', w: 0.85, d: 0.85, h: 0.85, color: '#9aa7b3' },
  'coffee-table': { label: 'Coffee table', cat: 'living', w: 1.2, d: 0.6, h: 0.4, color: '#a07c5a' },
  'tv-unit': { label: 'TV unit', cat: 'living', w: 1.8, d: 0.45, h: 0.5, color: '#4a4d52', needs: { power: 300, voltage: 230, data: true } },
  'dining-6': { label: 'Dining table, 6 chairs', cat: 'living', w: 1.8, d: 2.1, h: 0.75, color: '#a07c5a' },
  'dining-4': { label: 'Dining table, 4 chairs', cat: 'living', w: 1.2, d: 2.0, h: 0.75, color: '#a07c5a' },
  bookshelf: { label: 'Bookshelf', cat: 'living', w: 1.0, d: 0.35, h: 2.0, color: '#b89b78' },
  'sofa-u': { label: 'U-shaped sofa', cat: 'living', w: 3.0, d: 2.2, h: 0.85, color: '#8c9aa8' },
  shelving: { label: 'Open shelving', cat: 'living', w: 1.2, d: 0.4, h: 2.0, color: '#b89b78' },
  'storage-unit': { label: 'Sideboard / storage unit', cat: 'living', w: 1.6, d: 0.45, h: 0.8, color: '#a07c5a' },
  projector: { label: 'Projector (ceiling-mounted)', cat: 'living', w: 0.4, d: 0.35, h: 0.15, color: '#3b3d40', mount: 'ceiling', needs: { power: 300, voltage: 230, data: true } },
  'projector-screen': { label: 'Projection screen', cat: 'living', w: 2.4, d: 0.1, h: 1.5, color: '#f4f4f4', mount: 0.7 },
  // bedroom & storage
  'bed-double': { label: 'Double bed 180', cat: 'bedroom', w: 1.8, d: 2.1, h: 0.5, color: '#e6e1d6' },
  'bed-queen': { label: 'Double bed 160', cat: 'bedroom', w: 1.6, d: 2.1, h: 0.5, color: '#e6e1d6' },
  'bed-single': { label: 'Single bed 90', cat: 'bedroom', w: 0.9, d: 2.0, h: 0.5, color: '#e6e1d6' },
  nightstand: { label: 'Bedside table', cat: 'bedroom', w: 0.45, d: 0.4, h: 0.5, color: '#b89b78' },
  wardrobe: { label: 'Wardrobe', cat: 'bedroom', w: 2.0, d: 0.6, h: 2.4, color: '#d9d3c7' },
  'closet-shelving': { label: 'Walk-in closet shelving', cat: 'bedroom', w: 1.0, d: 0.5, h: 2.4, color: '#d9d3c7', builtIn: true },
  dresser: { label: 'Chest of drawers', cat: 'bedroom', w: 1.2, d: 0.5, h: 0.8, color: '#b89b78' },
  desk: { label: 'Desk', cat: 'bedroom', w: 1.4, d: 0.7, h: 0.75, color: '#b89b78', needs: { power: 300, voltage: 230, data: true } },
  // bathroom
  bathtub: { label: 'Bathtub', cat: 'bathroom', w: 1.7, d: 0.75, h: 0.55, color: '#f7f7f7', needs: { water: ['cold', 'hot'], drain: 50 } },
  shower: { label: 'Shower 90 × 90', cat: 'bathroom', w: 0.9, d: 0.9, h: 0.05, color: '#e8eef2', needs: { water: ['cold', 'hot'], drain: 50 } },
  'shower-walkin': { label: 'Walk-in shower 120 × 90', cat: 'bathroom', w: 1.2, d: 0.9, h: 0.05, color: '#e8eef2', needs: { water: ['cold', 'hot'], drain: 50 } },
  wc: { label: 'Toilet', cat: 'bathroom', w: 0.4, d: 0.65, h: 0.4, color: '#f7f7f7', needs: { water: ['cold'], drain: 110 } },
  washbasin: { label: 'Washbasin', cat: 'bathroom', w: 0.6, d: 0.45, h: 0.85, color: '#f7f7f7', needs: { water: ['cold', 'hot'], drain: 40 } },
  'vanity-double': { label: 'Double washbasin', cat: 'bathroom', w: 1.2, d: 0.5, h: 0.85, color: '#f7f7f7', needs: { water: ['cold', 'hot'], drain: 40 } },
  'towel-rail': { label: 'Electric towel rail', cat: 'bathroom', w: 0.5, d: 0.1, h: 1.2, color: '#dcdcdc', needs: { power: 500, voltage: 230 } },
  // utility & technical
  washer: { label: 'Washing machine', cat: 'utility', w: 0.6, d: 0.6, h: 0.85, color: '#f2f2f2', needs: { power: 2200, voltage: 230, dedicated: true, water: ['cold'], drain: 40 } },
  dryer: { label: 'Tumble dryer', cat: 'utility', w: 0.6, d: 0.6, h: 0.85, color: '#f2f2f2', needs: { power: 1000, voltage: 230, dedicated: true, drain: 40 } },
  'boiler-gas': { label: 'Gas boiler', cat: 'utility', w: 0.45, d: 0.35, h: 0.75, color: '#f2f2f2', needs: { power: 150, voltage: 230, gas: true, water: ['cold', 'hot'], drain: 32, flue: true } },
  'heat-pump': { label: 'Heat pump (indoor unit)', cat: 'utility', w: 0.6, d: 0.6, h: 1.8, color: '#f2f2f2', needs: { power: 6000, voltage: 400, dedicated: true, water: ['cold', 'hot'], drain: 32 } },
  'heat-pump-outdoor': { label: 'Heat pump outdoor unit', cat: 'utility', w: 1.0, d: 0.4, h: 0.9, color: '#e6e6e6' },
  'ufh-manifold': { label: 'Underfloor heating manifold', cat: 'utility', w: 0.8, d: 0.12, h: 0.6, color: '#c7c7c7', mount: 0.3 },
  'hrv-unit': { label: 'Ventilation unit (heat recovery)', cat: 'utility', w: 0.7, d: 0.6, h: 0.9, color: '#f2f2f2', needs: { power: 150, voltage: 230, drain: 32 } },
  'water-heater': { label: 'Hot water cylinder', cat: 'utility', w: 0.6, d: 0.6, h: 1.8, color: '#f2f2f2', needs: { power: 2000, voltage: 230, dedicated: true, water: ['cold', 'hot'] } },
  'utility-sink': { label: 'Utility sink', cat: 'utility', w: 0.5, d: 0.5, h: 0.85, color: '#cfd6dc', needs: { water: ['cold', 'hot'], drain: 50 } },
  // garage & outdoor
  car: { label: 'Car', cat: 'garage', w: 1.9, d: 4.6, h: 1.5, color: '#7d8b99' },
  'ev-charger': { label: 'EV charger (11 kW)', cat: 'garage', w: 0.3, d: 0.15, h: 0.4, color: '#2f6fd6', needs: { power: 11000, voltage: 400, dedicated: true } },
};

export const itemInfo = (item) => ITEMS[item.type] || { label: item.type, cat: 'living', w: 1, d: 1, h: 1, color: '#cccccc' };

// Plan footprint (rotation swaps width and depth).
export function footprint(item) {
  const turned = item.rot === 90 || item.rot === 270;
  return { x: item.x, y: item.y, w: turned ? item.d : item.w, h: turned ? item.w : item.d };
}

// Plan position of a point given in the item's own frame (u along the front, v from the back).
export function itemPoint(item, u, v) {
  const f = footprint(item);
  const cx = f.x + f.w / 2;
  const cy = f.y + f.h / 2;
  const lu = u - item.w / 2;
  const lv = v - item.d / 2;
  const a = ((item.rot || 0) * Math.PI) / 180;
  return [cx + lu * Math.cos(a) - lv * Math.sin(a), cy + lu * Math.sin(a) + lv * Math.cos(a)];
}

export function newItem(type, id, cx, cy) {
  const c = ITEMS[type];
  return { id, type, x: Math.round((cx - c.w / 2) * 20) / 20, y: Math.round((cy - c.d / 2) * 20) / 20, w: c.w, d: c.d, h: c.h, rot: 0 };
}

export function rotateItem(item, by = 90) {
  const f = footprint(item);
  const cx = f.x + f.w / 2;
  const cy = f.y + f.h / 2;
  item.rot = (((item.rot || 0) + by) % 360 + 360) % 360;
  const g = footprint(item);
  item.x = Math.round((cx - g.w / 2) * 100) / 100;
  item.y = Math.round((cy - g.h / 2) * 100) / 100;
}

// Room a point lies in.
export function roomAt(floor, x, y) {
  return floor.rooms.find((r) => inRoom(r, x, y)) || null;
}
