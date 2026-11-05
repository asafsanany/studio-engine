import { z } from 'zod';

// The team (Team plan, TM0): who may open the engine, and which clients each editor sees.
// The owner (the Mac's owner) is the admin and is never stored. Yael and Amit are editors. The team
// lives in <dataDir>/team.json (server: team/team-service.ts); this module holds its shape and the
// shapes the API gives the web.

/** The file's name inside the data folder. */
export const TEAM_FILE_NAME = 'team.json';

/** `admin` sees everything; an `editor` sees only the clients assigned to them. */
export const TEAM_ROLES = ['admin', 'editor'] as const;
export const teamRoleSchema = z.enum(TEAM_ROLES);
export type TeamRole = z.infer<typeof teamRoleSchema>;

/** How a request reached the engine: from this Mac itself, or through Tailscale Serve. */
export const VIEWER_VIAS = ['local', 'tailscale'] as const;
export const viewerViaSchema = z.enum(VIEWER_VIAS);
export type ViewerVia = z.infer<typeof viewerViaSchema>;

/**
 * Who is asking. `email` is exactly what Tailscale sends as the login, lowercased (not always an
 * email: a GitHub login looks like `name@github`); `local` for a request from this Mac itself.
 */
export const viewerSchema = z.object({
  email: z.string().min(1),
  name: z.string(),
  role: teamRoleSchema,
  via: viewerViaSchema,
});
export type Viewer = z.infer<typeof viewerSchema>;

/** `GET /api/me`: who the engine thinks is asking. */
export const meResponseSchema = viewerSchema.pick({ email: true, name: true, role: true });
export type MeResponse = z.infer<typeof meResponseSchema>;

/** One person of the team. `email` is the Tailscale login, lowercase. */
export const teamUserSchema = z.object({
  email: z.string().trim().toLowerCase().min(1),
  name: z.string(),
  role: teamRoleSchema,
});
export type TeamUser = z.infer<typeof teamUserSchema>;

/** One client's editors, with the client's name kept beside its id so the file reads on its own. */
export const teamAssignmentSchema = z.object({
  client: z.string(),
  editors: z.array(z.string().trim().toLowerCase().min(1)),
});
export type TeamAssignment = z.infer<typeof teamAssignmentSchema>;

/** The whole of team.json. A client with no entry (or no editors) is for the admin only. */
export const teamFileSchema = z.object({
  users: z.array(teamUserSchema).default([]),
  assignments: z.record(z.string(), teamAssignmentSchema).default({}),
});
export type TeamFile = z.infer<typeof teamFileSchema>;

// --- the team API (TM3): admin only ------------------------------------------------------------

/** `GET /api/team`: everyone on the team (not the owner) and the editors of each assigned client. */
export const teamResponseSchema = z.object({
  users: z.array(teamUserSchema),
  assignments: z.record(z.string(), teamAssignmentSchema),
});
export type TeamResponse = z.infer<typeof teamResponseSchema>;

/** `POST /api/team` body: add a person. The login is lowercased by the server. */
export const addTeamUserRequestSchema = z.object({
  name: z.string(),
  email: z.string(),
  role: teamRoleSchema,
});
export type AddTeamUserRequest = z.infer<typeof addTeamUserRequestSchema>;

/** `PUT /api/team/:email` body: change a person's name and/or role; what is left out stays. */
export const updateTeamUserRequestSchema = z.object({
  name: z.string().optional(),
  role: teamRoleSchema.optional(),
});
export type UpdateTeamUserRequest = z.infer<typeof updateTeamUserRequestSchema>;

/** `PUT /api/clients/:clientId/assignees` body: the logins of the client's editors (replaces the list). */
export const setAssigneesRequestSchema = z.object({ editors: z.array(z.string()) });
export type SetAssigneesRequest = z.infer<typeof setAssigneesRequestSchema>;

/** `PUT /api/clients/:clientId/assignees`: the client's editors now. Empty: the admin only. */
export const assigneesResponseSchema = z.object({
  clientId: z.string(),
  client: z.string(),
  editors: z.array(z.string()),
});
export type AssigneesResponse = z.infer<typeof assigneesResponseSchema>;
