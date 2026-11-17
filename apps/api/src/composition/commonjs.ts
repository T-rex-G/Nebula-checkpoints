/*
 * The CommonJS modules the server still reads from src/, named once.
 *
 * Node hands an ES module a CommonJS module's exports as its default import.
 * These modules freeze what they export, so their names cannot be read from
 * their source ahead of time, and a named import of one fails when the server
 * starts. Each is imported whole here instead, and its exports named.
 */
import capabilityRegistry from '../../../../src/capability-registry.js';
import qualification from '../../../../src/qualification-capabilities.js';
import publicAssets from '../../../../src/public-assets.js';

export const { CapabilityError, assertCapabilityAvailable, legacyCapsFor, loadCapabilityDocument, projectCapabilities, resolveCapability } = capabilityRegistry;
export const { loadQualificationCapabilities } = qualification;
export const { securityContact } = publicAssets;
