import { asyncHandler } from "../middlewares/asyncHandler.js";
import {
  findByUsername,
  followUser,
  getProfileWithFollowing,
  unfollowUser,
} from "../models/user.model.js";

const DEFAULT_AVATAR = process.env.DEFAULT_AVATAR_URL || "";

/** GET /api/profiles/:username */
export const getProfile = asyncHandler(async (req, res) => {
  const viewerId = req.user?.id || null;
  const { username } = req.params;

  const profile = await getProfileWithFollowing(username, viewerId);
  if (!profile) return res.status(404).json({ error: "User not found" });

  return res.json({
    profile: {
      username: profile.username,
      bio: profile.bio || "",
      image: profile.image || DEFAULT_AVATAR,
      following: !!profile.following,
    },
  });
});

/** POST /api/profiles/:username/follow */
export const followProfile = asyncHandler(async (req, res) => {
  const viewer = req.user;
  const { username } = req.params;

  const target = await findByUsername(username);
  if (!target) return res.status(404).json({ error: "User not found" });
  if (target.id === viewer.id) {
    return res.status(400).json({ error: "You cannot follow yourself" });
  }

  await followUser(viewer.id, target.id);
  const profile = await getProfileWithFollowing(username, viewer.id);

  return res.json({
    profile: {
      image: profile.image || DEFAULT_AVATAR,
      bio: profile.bio || "",
      username: profile.username,
      following: !!profile.following,
    },
  });
});

/** DELETE /api/profiles/:username/follow */
export const unfollowProfile = asyncHandler(async (req, res) => {
  const viewer = req.user;
  const { username } = req.params;

  const target = await findByUsername(username);
  if (!target) return res.status(404).json({ error: "User not found" });
  if (target.id === viewer.id) {
    return res.status(400).json({ error: "You cannot unfollow yourself" });
  }

  await unfollowUser(viewer.id, target.id);
  const profile = await getProfileWithFollowing(username, viewer.id);

  return res.json({
    profile: {
      image: profile.image || DEFAULT_AVATAR,
      bio: profile.bio || "",
      username: profile.username,
      following: !!profile.following,
    },
  });
});
