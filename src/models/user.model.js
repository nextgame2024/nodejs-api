import { v4 as uuid } from "uuid";
import bcrypt from "bcryptjs";

const passwordPlain = "Goldenboot2020";
const passwordHash = bcrypt.hashSync(passwordPlain, 10);

export const users = [
  {
    id: "5e0bfc03-0c0f-4773-ba3a-b5aa4f013443",
    email: "seb@gmail.com",
    username: "seb",
    image: "",
    bio: "",
    password: passwordHash,
    createdAt: new Date("2025-06-18T08:01:23.815Z"),
    updatedAt: new Date("2025-06-18T08:01:23.815Z"),
  },
];

/** Find user by email. Replace with DB query. */
export function findByEmail(email) {
  return users.find((u) => u.email === email);
}

/** Create and push new user (not used in login example). */
export function create({ email, password, username }) {
  const now = new Date();
  const user = {
    id: uuid(),
    email,
    username,
    password: bcrypt.hashSync(password, 10),
    image: "",
    bio: "",
    createdAt: now,
    updatedAt: now,
  };
  users.push(user);
  return user;
}
