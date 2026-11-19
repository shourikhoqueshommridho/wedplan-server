export const VENDOR_BUSINESS_CATEGORIES = [
  "Photography & Videography",
  "Wedding Venues",
  "Decoration & Florist",
  "Catering Services",
  "Makeup & Styling",
  "Wedding Fashion",
] as const

export type VendorBusinessCategory = (typeof VENDOR_BUSINESS_CATEGORIES)[number]

export function isVendorBusinessCategory(value: unknown): value is VendorBusinessCategory {
  return (
    typeof value === "string" &&
    (VENDOR_BUSINESS_CATEGORIES as readonly string[]).includes(value)
  )
}

/** Business details collected during vendor registration or later edits. */
export interface VendorBusinessDetails {
  businessName: string
  category: VendorBusinessCategory
  phone: string
  location: string
  website?: string | null
  description: string
}

export interface VendorProfileRecord extends VendorBusinessDetails {
  _id?: unknown
  userId: string
  contactEmail: string
  createdAt: Date
  updatedAt: Date
}

/** Presentation shape returned by the vendor API. */
export interface VendorProfile extends VendorBusinessDetails {
  id: string
  userId: string
  contactEmail: string
  createdAt: string | null
  updatedAt: string | null
}
