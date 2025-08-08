import { asyncHandler } from "../middlewares/asyncHandler.js";
import { authRequired } from "../middlewares/authJwt.js";
import {
  findByUsername,
  followUser,
  getProfileWithFollowing,
} from "../models/user.model.js";

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
      image: profile.image,
      bio: profile.bio,
      username: profile.username,
      following: !!profile.following,
    },
  });
});
