.PHONY: run build test audit replay smoke
IMAGE ?= lain-zip-apertus:local
build:
	docker build -t $(IMAGE) -f Dockerfile ..
run: build
	mkdir -p outputs
	docker run --rm --read-only --tmpfs /tmp:rw,size=256m -p 127.0.0.1:7860:7860 -v "$(CURDIR)/outputs:/app/track_2b/outputs" -e LLM_NAME -e LLM_BASE_URL -e LLM_API_KEY $(IMAGE)
test:
	python -m unittest discover -s tests -v
audit:
	python src/verify_evidence.py
	python src/verify_prototype_smoke.py
replay:
	python src/show_recorded_trace.py
smoke: build
	docker run --rm --read-only --tmpfs /tmp:rw,size=256m --entrypoint python $(IMAGE) track_2b/src/verify_evidence.py
