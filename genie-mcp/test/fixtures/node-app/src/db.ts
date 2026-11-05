export const db = {
  query(_table: string): unknown[] {
    return [];
  },
  insert(_table: string, value: unknown) {
    return value;
  },
};

export function connectDb() {
  return db;
}
