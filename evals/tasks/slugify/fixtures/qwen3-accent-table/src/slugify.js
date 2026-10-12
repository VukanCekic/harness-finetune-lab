export function slugify(text) {
  let result = text.toLowerCase();

  const accentsMap = {
    'ÀÁÂÄÅ': 'A',
    'àáâäå': 'a',
    'ÈÉÊË': 'E',
    'èéêë': 'e',
    'ÌÍÎÏ': 'I',
    'ìíîï': 'i',
    'ÒÓÔÕÖØ': 'O',
    'òóôõöø': 'o',
    'ÙÚÛÜ': 'U',
    'ùúûü': 'u',
    'ÝŸ': 'Y',
    'ýÿ': 'y'
  };

  for (let [key, value] of Object.entries(accentsMap)) {
    const regex = new RegExp(`[${key}]`, 'g');
    result = result.replace(regex, value);
  }

  // Replace sequences of non-alphanumeric with hyphens
  result = result.replace(/[^a-z0-9]+/g, '-');

  // Trim leading/trailing hyphens
  return result.trim().replace(/^-*|-*$/g, '');
}