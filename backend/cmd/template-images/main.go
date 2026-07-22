package main

import (
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/pika/db-mock/internal/templates"
)

func main() {
	architecturesByImage := make(map[string]map[string]struct{})
	for _, definition := range templates.Builtins() {
		references := []string{definition.Image}
		if definition.Compose != "" {
			var err error
			references, err = templates.ComposeImageReferences(definition.Slug, definition.Compose, definition.Image)
			if err != nil {
				fmt.Fprintf(os.Stderr, "resolve %s images: %v\n", definition.Slug, err)
				os.Exit(1)
			}
		}
		for _, reference := range references {
			if architecturesByImage[reference] == nil {
				architecturesByImage[reference] = make(map[string]struct{})
			}
			for _, architecture := range definition.Architectures {
				architecturesByImage[reference][architecture] = struct{}{}
			}
		}
	}
	images := make([]string, 0, len(architecturesByImage))
	for image := range architecturesByImage {
		images = append(images, image)
	}
	sort.Strings(images)
	for _, image := range images {
		architectures := make([]string, 0, len(architecturesByImage[image]))
		for architecture := range architecturesByImage[image] {
			architectures = append(architectures, architecture)
		}
		sort.Strings(architectures)
		fmt.Printf("%s\t%s\n", image, strings.Join(architectures, ","))
	}
}
