export const categories = [
  { slug: 'audio', name: 'Audio', emoji: '🎧', blurb: 'Headphones, speakers & in-ears' },
  { slug: 'wearables', name: 'Wearables', emoji: '⌚', blurb: 'Smartwatches & fitness bands' },
  { slug: 'computing', name: 'Computing', emoji: '💻', blurb: 'Laptops, mice & keyboards' },
  { slug: 'photo', name: 'Photo', emoji: '📷', blurb: 'Cameras & lenses' },
  { slug: 'home', name: 'Smart Home', emoji: '🏠', blurb: 'Lights, plugs & hubs' },
]

export const findCategory = (slug) => categories.find((c) => c.slug === slug)
