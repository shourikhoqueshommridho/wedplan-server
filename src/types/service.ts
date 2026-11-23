import type { ObjectId } from "mongodb"

export type ServiceSortOrder = "asc" | "desc"

export interface ServiceQuery {
  search?: string
  category?: string
  location?: string
  sort?: ServiceSortOrder
}

/**
 * Shape of a document in `wedplan.services`. Fields are declared with the
 * expected Mongo types, but every value is still validated at runtime before it
 * is exposed through the public API.
 */
export interface ServiceRecord {
  _id?: string | ObjectId
  serviceName: string
  category: string
  description: string
  price: number
  location: string
  images: string[]
  vendorId: string
  vendorName: string
  vendorImage?: string | null
  status: string
  isActive: boolean
  /** Free-plan slot reservation (1..3). Absent for premium/inactive listings. */
  quotaSlot?: number
  createdAt?: Date | string
}

export interface PublicServicePrice {
  amount: number
  currency: "BDT"
  unit: "package"
}

export interface PublicService {
  id: string
  name: string
  category: string
  categoryLabel: string
  shortDescription: string
  price: PublicServicePrice
  location: {
    city: string
    country: string
  }
  vendor: {
    id: string
    name: string
    initials: string
    image?: string
  }
  image: {
    src: string
    alt: string
  }
  images: string[]
  createdAt?: string
}

export interface PublicServiceList {
  services: PublicService[]
  total: number
  locations: string[]
}
