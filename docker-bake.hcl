# Multi-arch release build: linux/amd64 + linux/arm64 in one go, pushed to Docker Hub.
#
#   docker login
#   docker buildx bake                       # builds both arches, pushes :latest
#   VERSION=2.0.0 docker buildx bake         # also pushes the immutable :2.0.0 tag
#   docker buildx bake --print               # show the resolved config without building

variable "IMAGE" {
  default = "spyminer/abyss-deco-planner"
}

# Optional extra tag; stacks should pin an immutable version rather than :latest.
variable "VERSION" {
  default = ""
}

group "default" {
  targets = ["app"]
}

target "app" {
  context    = "."
  dockerfile = "Dockerfile"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags = compact([
    "${IMAGE}:latest",
    notequal(VERSION, "") ? "${IMAGE}:${VERSION}" : "",
  ])
  # Push straight to the registry (a multi-arch manifest list can't be loaded into the local image store).
  output = ["type=registry"]
}
