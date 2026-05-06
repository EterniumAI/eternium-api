import * as projects from "@eternium/centramind-core/dist/services/projects.js";
import * as infra from "@eternium/centramind-core/dist/services/infra.js";

// TODO: Wire finance.*, clients.*, tenants.* tools after op-1's W3b PR merges.
// Imports ready:
//   import * as finance from "@eternium/centramind-core/dist/services/finance.js";
//   import * as clients from "@eternium/centramind-core/dist/services/clients.js";
//   import * as tenants from "@eternium/centramind-core/dist/services/tenants.js";
//
// Registry entries:
//   "finance.summary":        { fn: finance.financeSummary,        schema: finance.FinanceSummaryArgs },
//   "finance.mrr_history":    { fn: finance.financeMrrHistory,     schema: finance.FinanceMrrHistoryArgs },
//   "finance.revenue_by_product": { fn: finance.financeRevenueByProduct, schema: finance.FinanceRevenueByProductArgs },
//   "clients.list":           { fn: clients.clientsList,           schema: clients.ClientsListArgs },
//   "clients.get":            { fn: clients.clientsGet,            schema: clients.ClientsGetArgs },
//   "clients.create":         { fn: clients.clientsCreate,         schema: clients.ClientsCreateArgs },
//   "tenants.list":           { fn: tenants.tenantsList,           schema: tenants.TenantsListArgs },
//   "tenants.get":            { fn: tenants.tenantsGet,            schema: tenants.TenantsGetArgs },
//   "tenants.provision":      { fn: tenants.tenantsProvision,      schema: tenants.TenantsProvisionArgs },

export const TOOL_REGISTRY = {
	"projects.list":            { fn: projects.projectsList,           schema: projects.ProjectsListArgs },
	"projects.get":             { fn: projects.projectsGet,            schema: projects.ProjectsGetArgs },
	"projects.create":          { fn: projects.projectsCreate,         schema: projects.ProjectsCreateArgs },
	"projects.update_status":   { fn: projects.projectsUpdateStatus,   schema: projects.ProjectsUpdateStatusArgs },
	"projects.link_infrastructure": { fn: projects.projectsLinkInfrastructure, schema: projects.ProjectsLinkInfraArgs },
	"projects.add_member":      { fn: projects.projectsAddMember,      schema: projects.ProjectsAddMemberArgs },
	"projects.usage_summary":   { fn: projects.projectsUsageSummary,   schema: projects.ProjectsUsageSummaryArgs },
	"infra.list":               { fn: infra.infraList,                 schema: infra.InfraListArgs },
	"infra.get":                { fn: infra.infraGet,                  schema: infra.InfraGetArgs },
	"infra.register":           { fn: infra.infraRegister,             schema: infra.InfraRegisterArgs },
	"infra.verify":             { fn: infra.infraVerify,               schema: infra.InfraVerifyArgs },
	"infra.update_cost":        { fn: infra.infraUpdateCost,           schema: infra.InfraUpdateCostArgs },
	"infra.console_url":        { fn: infra.infraConsoleUrl,           schema: infra.InfraConsoleUrlArgs },
};

export function isKnownTool(name) {
	return Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, name);
}
