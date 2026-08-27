"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.organizationFromHeelLife = organizationFromHeelLife;
const util_1 = require("../lib/util");
function organizationFromHeelLife(input) {
    return { id: (0, util_1.stableId)('org', input.heelLifeUrl), name: input.name, school: input.school ?? 'University of North Carolina at Chapel Hill', heelLifeUrl: input.heelLifeUrl, websiteUrl: input.websiteUrl, instagramHandle: input.instagramHandle, linkedinUrl: input.linkedinUrl };
}
