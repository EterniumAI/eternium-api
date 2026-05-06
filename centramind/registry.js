import * as projects from "@eternium/centramind-core/dist/services/projects.js";
import * as infra from "@eternium/centramind-core/dist/services/infra.js";
import * as finance from "@eternium/centramind-core/dist/services/finance.js";
import * as clients from "@eternium/centramind-core/dist/services/clients.js";
import * as tenants from "@eternium/centramind-core/dist/services/tenants.js";

export const TOOL_REGISTRY = {
	// projects.* (7)
	"projects.list":                 { fn: projects.projectsList,                schema: projects.ProjectsListArgs },
	"projects.get":                  { fn: projects.projectsGet,                 schema: projects.ProjectsGetArgs },
	"projects.create":               { fn: projects.projectsCreate,              schema: projects.ProjectsCreateArgs },
	"projects.update_status":        { fn: projects.projectsUpdateStatus,        schema: projects.ProjectsUpdateStatusArgs },
	"projects.link_infrastructure":  { fn: projects.projectsLinkInfrastructure,  schema: projects.ProjectsLinkInfraArgs },
	"projects.add_member":           { fn: projects.projectsAddMember,           schema: projects.ProjectsAddMemberArgs },
	"projects.usage_summary":        { fn: projects.projectsUsageSummary,        schema: projects.ProjectsUsageSummaryArgs },

	// infra.* (6)
	"infra.list":                    { fn: infra.infraList,                      schema: infra.InfraListArgs },
	"infra.get":                     { fn: infra.infraGet,                       schema: infra.InfraGetArgs },
	"infra.register":                { fn: infra.infraRegister,                  schema: infra.InfraRegisterArgs },
	"infra.verify":                  { fn: infra.infraVerify,                    schema: infra.InfraVerifyArgs },
	"infra.update_cost":             { fn: infra.infraUpdateCost,                schema: infra.InfraUpdateCostArgs },
	"infra.console_url":             { fn: infra.infraConsoleUrl,                schema: infra.InfraConsoleUrlArgs },

	// finance.* (7)
	"finance.ledger_query":          { fn: finance.financeLedgerQuery,           schema: finance.FinanceLedgerQueryArgs },
	"finance.bills_list":            { fn: finance.financeBillsList,             schema: finance.FinanceBillsListArgs },
	"finance.bill_propose":          { fn: finance.financeBillPropose,           schema: finance.FinanceBillProposeArgs },
	"finance.bill_approve":          { fn: finance.financeBillApprove,           schema: finance.FinanceBillApproveArgs },
	"finance.bill_reconcile":        { fn: finance.financeBillReconcile,         schema: finance.FinanceBillReconcileArgs },
	"finance.mrr_current":           { fn: finance.financeMrrCurrent,            schema: finance.FinanceMrrCurrentArgs },
	"finance.transaction_record":    { fn: finance.financeTransactionRecord,     schema: finance.FinanceTransactionRecordArgs },

	// clients.* (4)
	"clients.list":                  { fn: clients.clientsList,                  schema: clients.ClientsListArgs },
	"clients.get":                   { fn: clients.clientsGet,                   schema: clients.ClientsGetArgs },
	"clients.create":                { fn: clients.clientsCreate,                schema: clients.ClientsCreateArgs },
	"clients.assign_project":        { fn: clients.clientsAssignProject,         schema: clients.ClientsAssignProjectArgs },

	// tenants.* (3)
	"tenants.list":                  { fn: tenants.tenantsList,                  schema: tenants.TenantsListArgs },
	"tenants.create":                { fn: tenants.tenantsCreate,                schema: tenants.TenantsCreateArgs },
	"tenants.add_member":            { fn: tenants.tenantsAddMember,             schema: tenants.TenantsAddMemberArgs },
};

export function isKnownTool(name) {
	return Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, name);
}
