import { asyncHandler } from "../middlewares/asyncHandler.js";
import { findByUsername } from "../models/user.model.js";

const DEFAULT_AVATAR = process.env.DEFAULT_AVATAR_URL || "";

/** GET /api/profiles/:username */
export const getProfile = asyncHandler(async (req, res) => {
  const { username } = req.params;

  const profile = await findByUsername(username);
  if (!profile) return res.status(404).json({ error: "User not found" });

  return res.json({
    profile: {
      username: profile.username,
      bio: profile.bio || "",
      image: profile.image || DEFAULT_AVATAR,
    },
  });
});
