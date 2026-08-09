export function isConsecutive(seatNumbers: number[]): boolean {
  if (seatNumbers.length === 0) return false;
  const s = [...seatNumbers].sort((a, b) => a - b);
  return s.every((n, i) => i === 0 || n === s[i - 1] + 1);
}

export function findTrappedSeat(
  occupiedAfter: { seatNumber: number; occupied: boolean }[],
): number | null {
  const s = [...occupiedAfter].sort((a, b) => a.seatNumber - b.seatNumber);
  let lastOcc = -1;
  for (let i = 0; i < s.length; i++) {
    if (!s[i].occupied) continue;
    if (lastOcc !== -1 && i - lastOcc === 2) return s[i - 1].seatNumber;
    lastOcc = i;
  }
  return null;
}
