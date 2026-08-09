CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS map_instances (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS seats (
  id SERIAL PRIMARY KEY,
  instance_id INT NOT NULL REFERENCES map_instances(id),
  row_number INT NOT NULL,
  seat_number INT NOT NULL,
  UNIQUE (instance_id, row_number, seat_number)
);
CREATE TABLE IF NOT EXISTS reservations (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  instance_id INT NOT NULL REFERENCES map_instances(id),
  status TEXT NOT NULL CHECK (status IN ('held','booked','expired','released')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS reservation_seats (
  reservation_id INT NOT NULL REFERENCES reservations(id),
  seat_id INT NOT NULL REFERENCES seats(id),
  PRIMARY KEY (reservation_id, seat_id)
);
CREATE INDEX IF NOT EXISTS idx_resseats_seat ON reservation_seats(seat_id);
CREATE INDEX IF NOT EXISTS idx_res_instance_status ON reservations(instance_id, status);
