.PHONY: all run test appimage deb rpm clean

all:
	./build.sh

run:
	./siren

test:
	gjs -m tests/test-core.js
	desktop-file-validate data/io.github.mauvesea.Siren.desktop

appimage:
	./build.sh appimage

deb:
	./build.sh deb

rpm:
	./build.sh rpm

clean:
	$(RM) -r SirenAppDir
	$(RM) Siren-*.AppImage Siren-*.deb Siren-*.rpm
