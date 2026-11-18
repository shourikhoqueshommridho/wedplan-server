import { Router } from "express"

import { getServiceById, getServices } from "../controllers/services.controller.js"

const servicesRouter = Router()

servicesRouter.get("/", getServices)
servicesRouter.get("/:id", getServiceById)

export default servicesRouter
