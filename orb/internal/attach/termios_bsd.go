//go:build darwin || freebsd || netbsd || openbsd || dragonfly

package attach

import "golang.org/x/sys/unix"

func getTermios(fd int) (*unix.Termios, error) {
	return unix.IoctlGetTermios(fd, unix.TIOCGETA)
}

func setTermios(fd int, termios *unix.Termios) error {
	return unix.IoctlSetTermios(fd, unix.TIOCSETA, termios)
}
