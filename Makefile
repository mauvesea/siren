.PHONY: all linux run test windows windows-installer windows-dir windows-test appimage deb rpm clean

all: linux windows

linux:
	./build.sh

run:
	./siren

test:
	gjs -m tests/integration/conversion-workflow.test.js
	gjs -m tests/integration/parameter-validation.test.js
	desktop-file-validate data/io.github.mauvesea.Siren.desktop

windows:
	./build-windows.sh

windows-installer:
	npm run windows:installer

windows-dir:
	npm run windows:dir

windows-test:
	npm run test:windows

appimage:
	./build.sh appimage

deb:
	./build.sh deb

rpm:
	./build.sh rpm

clean:
	$(RM) -r SirenAppDir
	$(RM) -r dist
	$(RM) Siren-*.AppImage Siren-*.deb Siren-*.rpm
