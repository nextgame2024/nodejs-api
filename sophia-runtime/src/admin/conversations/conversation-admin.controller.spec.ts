import { describe, expect, it } from "@jest/globals";
import { ADMIN_PERMISSIONS_METADATA } from "../authorization/admin-permission.decorator.js";
import { ConversationAdminController } from "./conversation-admin.controller.js";

describe("ConversationAdminController permissions", () => {
  it("keeps metadata, content, annotation and export on separate API permissions", () => {
    const prototype = ConversationAdminController.prototype;
    expect(Reflect.getMetadata(ADMIN_PERMISSIONS_METADATA, prototype.list)).toEqual(["conversations.read_metadata"]);
    expect(Reflect.getMetadata(ADMIN_PERMISSIONS_METADATA, prototype.detail)).toEqual(["conversations.read_metadata"]);
    expect(Reflect.getMetadata(ADMIN_PERMISSIONS_METADATA, prototype.content)).toEqual(["conversations.read_content"]);
    expect(Reflect.getMetadata(ADMIN_PERMISSIONS_METADATA, prototype.note)).toEqual(["conversations.annotate"]);
    expect(Reflect.getMetadata(ADMIN_PERMISSIONS_METADATA, prototype.exports)).toEqual(["conversations.export"]);
    expect(Reflect.getMetadata(ADMIN_PERMISSIONS_METADATA, prototype.createExport)).toEqual(["conversations.export"]);
    expect(Reflect.getMetadata(ADMIN_PERMISSIONS_METADATA, prototype.downloadExport)).toEqual(["conversations.export"]);
  });
});
