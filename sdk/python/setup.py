from setuptools import setup, find_packages

setup(
    name="eternium-sdk",
    version="1.0.0",
    description="Official Eternium API SDK — AI image & video generation",
    long_description=open("README.md").read() if __import__("os").path.exists("README.md") else "",
    long_description_content_type="text/markdown",
    author="Eternium LLC",
    author_email="dev@eternium.ai",
    url="https://api.eternium.ai",
    project_urls={
        "Documentation": "https://api.eternium.ai/docs",
        "Source": "https://github.com/EterniumAI/eternium-sdk-python",
    },
    packages=find_packages(),
    python_requires=">=3.8",
    install_requires=[],
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Topic :: Software Development :: Libraries",
    ],
    keywords="eternium ai image video generation api sdk",
)
