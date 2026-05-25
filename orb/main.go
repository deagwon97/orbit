package main

import (
	"fmt"
	"os"

	"orb/cmd/cli"
	"orb/cmd/tui"
)

func main() {
	if len(os.Args) > 1 {
		if err := cli.Execute(os.Args[1:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	tui.Execute()
}
