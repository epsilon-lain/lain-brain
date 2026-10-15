.PHONY: run test audit replay smoke
run test audit replay smoke:
	$(MAKE) -C track_2b $@
