import { HubSpotContactProperties } from "../clients/hubspotClient";
import { DotloopContact } from "../clients/dotloopClient";

/** Canonical field set we keep in sync between the two contact records. */
export interface CanonicalContact {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
}

export const HUBSPOT_CONTACT_PROPERTIES = [
  "email",
  "firstname",
  "lastname",
  "phone",
  "address",
  "city",
  "state",
  "zip",
];

export function fromHubSpotContact(props: HubSpotContactProperties): CanonicalContact {
  return {
    email: props.email ?? "",
    firstName: props.firstname ?? "",
    lastName: props.lastname ?? "",
    phone: props.phone ?? "",
    address: props.address ?? "",
    city: props.city ?? "",
    state: props.state ?? "",
    zip: props.zip ?? "",
  };
}

export function toHubSpotContact(c: CanonicalContact): HubSpotContactProperties {
  return {
    email: c.email,
    firstname: c.firstName,
    lastname: c.lastName,
    phone: c.phone,
    address: c.address,
    city: c.city,
    state: c.state,
    zip: c.zip,
  };
}

export function fromDotloopContact(c: DotloopContact): CanonicalContact {
  return {
    email: c.email ?? "",
    firstName: c.firstName ?? "",
    lastName: c.lastName ?? "",
    phone: c.home ?? c.office ?? "",
    address: c.address ?? "",
    city: c.city ?? "",
    state: c.state ?? "",
    zip: c.zipCode ?? "",
  };
}

export function toDotloopContact(c: CanonicalContact): Partial<DotloopContact> {
  return {
    email: c.email,
    firstName: c.firstName,
    lastName: c.lastName,
    home: c.phone,
    address: c.address,
    city: c.city,
    state: c.state,
    zipCode: c.zip,
  };
}
