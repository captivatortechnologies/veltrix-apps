import handler0 from '../../operations/create-domain'
import handler1 from '../../operations/verify-domain'
import handler2 from '../../operations/delete-unverified-domain'
import handler3 from '../../operations/invite-guest'
import handler4 from '../../operations/set-user-manager'
import handler5 from '../../operations/clear-user-manager'
import handler6 from '../../operations/revoke-user-sessions'
import handler7 from '../../operations/delete-cloud-user'
import handler8 from '../../operations/delete-device'
import handler9 from '../../operations/restore-directory-object'
import handler10 from '../../operations/permanently-delete-directory-object'
import handler11 from '../../operations/revoke-app-role-assignment'
import handler12 from '../../operations/delete-federated-credential'
import handler13 from '../../operations/create-provisioning-job'
import handler14 from '../../operations/start-provisioning-job'
import handler15 from '../../operations/pause-provisioning-job'
import handler16 from '../../operations/restart-provisioning-job'
import handler17 from '../../operations/provision-on-demand'
import handler18 from '../../operations/execute-lifecycle-workflow'
import handler19 from '../../operations/review-apply-decisions'
import handler20 from '../../operations/review-stop'
import handler21 from '../../operations/review-reset-decisions'
import handler22 from '../../operations/risky-users-dismiss'
import handler23 from '../../operations/risky-users-confirm-compromised'
import handler24 from '../../operations/request-directory-role-assignment'
import handler25 from '../../operations/request-group-eligibility'
import handler26 from '../../operations/request-group-assignment'
import handler27 from '../../operations/add-group-member'
import handler28 from '../../operations/remove-group-member'
import handler29 from '../../operations/add-group-owner'
import handler30 from '../../operations/remove-group-owner'
import handler31 from '../../operations/request-access-package-assignment'
import handler32 from '../../operations/request-catalog-resource'
import handler33 from '../../operations/cancel-access-package-request'
import handler34 from '../../operations/reprocess-access-package-request'
import handler35 from '../../operations/remove-access-package-resource-role'
import handler36 from '../../operations/create-multitenant-organization'
import handler37 from '../../operations/add-multitenant-member'
import handler38 from '../../operations/join-multitenant-organization'
import handler39 from '../../operations/remove-multitenant-member'
import handler40 from '../../operations/report-users'
import handler41 from '../../operations/report-devices'
import handler42 from '../../operations/report-domains'
import handler43 from '../../operations/report-domain-dns-proof'
import handler44 from '../../operations/report-license-catalog'
import handler45 from '../../operations/report-user-license-details'
import handler46 from '../../operations/report-sign-ins'
import handler47 from '../../operations/report-directory-audit'
import handler48 from '../../operations/report-provisioning-audit'
import handler49 from '../../operations/report-risky-users'
import handler50 from '../../operations/report-risk-detections'
import handler51 from '../../operations/report-deleted-user'
import handler52 from '../../operations/report-deleted-group'
import handler53 from '../../operations/report-deleted-application'
import handler54 from '../../operations/report-deleted-servicePrincipal'
import handler55 from '../../operations/report-provisioning-jobs'
import handler56 from '../../operations/report-provisioning-templates'
import handler57 from '../../operations/report-review-instances'
import handler58 from '../../operations/report-review-decisions'
import handler59 from '../../operations/report-workflow-runs'
import handler60 from '../../operations/report-role-assignment-requests'
import handler61 from '../../operations/report-role-eligibility-requests'
import handler62 from '../../operations/report-group-eligibility-requests'
import handler63 from '../../operations/report-group-assignment-requests'
import handler64 from '../../operations/report-catalog-resources'
import handler65 from '../../operations/report-access-package-assignments'
import handler66 from '../../operations/report-access-package-requests'
import handler67 from '../../operations/report-catalog-resource-requests'
import handler68 from '../../operations/report-application-role-assignments'
import handler69 from '../../operations/report-group-members'
import handler70 from '../../operations/report-multitenant-members'
export const DECLARED_OPERATIONS = {
"create-domain": handler0,
"verify-domain": handler1,
"delete-unverified-domain": handler2,
"invite-guest": handler3,
"set-user-manager": handler4,
"clear-user-manager": handler5,
"revoke-user-sessions": handler6,
"delete-cloud-user": handler7,
"delete-device": handler8,
"restore-directory-object": handler9,
"permanently-delete-directory-object": handler10,
"revoke-app-role-assignment": handler11,
"delete-federated-credential": handler12,
"create-provisioning-job": handler13,
"start-provisioning-job": handler14,
"pause-provisioning-job": handler15,
"restart-provisioning-job": handler16,
"provision-on-demand": handler17,
"execute-lifecycle-workflow": handler18,
"review-apply-decisions": handler19,
"review-stop": handler20,
"review-reset-decisions": handler21,
"risky-users-dismiss": handler22,
"risky-users-confirm-compromised": handler23,
"request-directory-role-assignment": handler24,
"request-group-eligibility": handler25,
"request-group-assignment": handler26,
"add-group-member": handler27,
"remove-group-member": handler28,
"add-group-owner": handler29,
"remove-group-owner": handler30,
"request-access-package-assignment": handler31,
"request-catalog-resource": handler32,
"cancel-access-package-request": handler33,
"reprocess-access-package-request": handler34,
"remove-access-package-resource-role": handler35,
"create-multitenant-organization": handler36,
"add-multitenant-member": handler37,
"join-multitenant-organization": handler38,
"remove-multitenant-member": handler39,
"report-users": handler40,
"report-devices": handler41,
"report-domains": handler42,
"report-domain-dns-proof": handler43,
"report-license-catalog": handler44,
"report-user-license-details": handler45,
"report-sign-ins": handler46,
"report-directory-audit": handler47,
"report-provisioning-audit": handler48,
"report-risky-users": handler49,
"report-risk-detections": handler50,
"report-deleted-user": handler51,
"report-deleted-group": handler52,
"report-deleted-application": handler53,
"report-deleted-servicePrincipal": handler54,
"report-provisioning-jobs": handler55,
"report-provisioning-templates": handler56,
"report-review-instances": handler57,
"report-review-decisions": handler58,
"report-workflow-runs": handler59,
"report-role-assignment-requests": handler60,
"report-role-eligibility-requests": handler61,
"report-group-eligibility-requests": handler62,
"report-group-assignment-requests": handler63,
"report-catalog-resources": handler64,
"report-access-package-assignments": handler65,
"report-access-package-requests": handler66,
"report-catalog-resource-requests": handler67,
"report-application-role-assignments": handler68,
"report-group-members": handler69,
"report-multitenant-members": handler70
}
