export function outer(id: string) {
  try {
    return inner(id);
  } catch (err) {
    return null;
  }
}

export function inner(id: string) {
  if (!id) throw new BadId();
  const n = Number(id);
  if (n < 0) {
    throw new RangeError('negative');
  }
  return n;
}

class BadId extends Error {}
