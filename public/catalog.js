// Room and site element types with their display colours (2D fill / 3D floor).
export const ROOM_TYPES = {
  living: { label: 'Living room', color: '#f6e7c8' },
  kitchen: { label: 'Kitchen', color: '#f3dcb2' },
  bedroom: { label: 'Bedroom', color: '#dfe9f5' },
  bathroom: { label: 'Bathroom', color: '#d4eef0' },
  wc: { label: 'WC', color: '#d4eef0' },
  closet: { label: 'Closet', color: '#ece3f3' },
  hall: { label: 'Hall / corridor', color: '#efece6' },
  stairs: { label: 'Stairs', color: '#e6e1d8' },
  void: { label: 'Stair void', color: '#ffffff' },
  technical: { label: 'Technical', color: '#e4e4e4' },
  storage: { label: 'Storage / pantry', color: '#ebe6dc' },
  utility: { label: 'Utility', color: '#e4ebe1' },
  office: { label: 'Office', color: '#f3e3d9' },
  other: { label: 'Other', color: '#f0f0f0' },
};

export const SITE_TYPES = {
  plot: { label: 'Plot', color: '#e3efd6' },
  garage: { label: 'Garage', color: '#dcdad5' },
  terrace: { label: 'Terrace', color: '#e6cfa9' },
  pool: { label: 'Pool', color: '#8fd0ea' },
  greenhouse: { label: 'Greenhouse', color: '#d8f0dc' },
  driveway: { label: 'Driveway', color: '#cfcac2' },
  path: { label: 'Path', color: '#d9d4cb' },
  shed: { label: 'Garden shed', color: '#b8a58a' },
  carport: { label: 'Carport (roof on posts)', color: '#d6d2ca' },
  pergola: { label: 'Pergola / terrace cover', color: '#d9c8ad' },
  tree: { label: 'Tree', color: '#7fb069' },
  conifer: { label: 'Conifer', color: '#3f7a4f' },
  bush: { label: 'Bush', color: '#8cbf6a' },
  hedge: { label: 'Hedge', color: '#5f9447' },
  garden: { label: 'Garden bed (planting)', color: '#c9e2b3' },
  slope: { label: 'Slope / higher ground', color: '#b9d39a' },
  other: { label: 'Other', color: '#e8e8e8' },
};

export const roomColor = (type) => (ROOM_TYPES[type] || ROOM_TYPES.other).color;
export const siteColor = (type) => (SITE_TYPES[type] || SITE_TYPES.other).color;
